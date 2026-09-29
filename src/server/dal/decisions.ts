import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import type { DbOrTx } from "../db/client";
import { assignments, events, judgeOverrides, projects } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { newId } from "../util";
import { organizerMutation, type EventRow } from "./events";
import { isJudgeIn } from "./judges";
import { finishedReviews, judgeSet, submittedProjects, type ProjectInfo } from "./judging";
import { computePairwise, judgingModeOf, pairwiseDecisions, type CoinFlipDecision, type PairwiseComputed } from "./pairwise";
import { parse } from "./parse";
import { computeNormalization, type Normalized } from "./normalization";
import { countBeforeChange, recordCountChange } from "./voting-organizer";

// The decisions that stand between an event's scores and published results, and the
// audited actions that settle them: a judge override (with a required reason), a duplicate
// merge, and accepting an under-reviewed project.

// ---------------------------------------------------------------------------
// Decisions before results can go out
// ---------------------------------------------------------------------------

const normTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");
const pairKey = (a: string, b: string) => [a, b].sort().join("|");

export type Decision =
  | {
      kind: "flat_judge";
      key: string;
      judgeId: string;
      name: string;
      vector: number[];
      reviews: number;
      /** projects whose raw-mean rank moves by a place or more when this judge is left out */
      movesIfOut: number;
      of: number;
      biggest: { title: string; from: number; to: number } | null;
      /** the judge's own projects: their scores and raw-mean rank with the judge and without */
      evidence: { projectId: string; title: string; values: number[]; from: number | null; to: number | null }[];
      resolved: { mode: "include" | "exclude"; reason: string } | null;
    }
  | {
      kind: "duplicate";
      key: string;
      team: string;
      title: string;
      copies: { id: string; title: string; submittedAt: string | null; repoUrl: string | null; rankRaw: number | null; n: number; duplicateOf: string | null }[];
      resolved: "merged" | "not_duplicates" | null;
      keptId: string | null;
    }
  | {
      kind: "under_reviewed";
      key: string;
      projectId: string;
      title: string;
      trackName: string;
      n: number;
      waiting: number;
      resolved: "accepted" | null;
      /** set in pairwise mode, where n counts the judges who compared it */
      mode?: "pairwise";
    }
  | CoinFlipDecision;

export function decisions(db: DbOrTx, event: EventRow, now = computeNormalization(db, event)): Decision[] {
  const out: Decision[] = [];
  const reviews = finishedReviews(db, event.id);
  const set = judgeSet(db, event.id, reviews);
  for (const flag of set.flags) {
    const override = [...set.overrides].reverse().find((o) => o.judgeId === flag.judgeId) ?? null;
    const without = new Set([...now.excluded, flag.judgeId]);
    const withJudge = new Set(now.excluded.filter((id) => id !== flag.judgeId));
    // One of the two sets is the run in hand (the judge is either in it or out of it): reuse it.
    const same = (x: Set<string>) => x.size === now.excluded.length && now.excluded.every((id) => x.has(id));
    const a = same(withJudge) ? now : computeNormalization(db, event, { exclude: [...withJudge] });
    const b = same(without) ? now : computeNormalization(db, event, { exclude: [...without] });
    // The exclusion's own effect: raw-mean ranks with the judge against without.
    const rankA = new Map(a.projects.map((p) => [p.id, p.rankKept]));
    let moves = 0;
    let biggest: { title: string; from: number; to: number } | null = null;
    for (const p of b.projects) {
      const from = rankA.get(p.id);
      if (from == null || p.rankKept == null) continue;
      const d = Math.abs(p.rankKept - from);
      if (d >= 1) moves++;
      if (d >= 1 && (!biggest || d > Math.abs(biggest.to - biggest.from))) biggest = { title: p.title, from, to: p.rankKept };
    }
    const rankB = new Map(b.projects.map((p) => [p.id, p.rankKept]));
    const evidence = reviews
      .filter((r) => r.judgeId === flag.judgeId)
      .map((r) => ({
        projectId: r.projectId,
        title: b.projects.find((p) => p.id === r.projectId)?.title ?? r.projectId,
        values: r.values,
        from: rankA.get(r.projectId) ?? null,
        to: rankB.get(r.projectId) ?? null,
      }));
    out.push({
      kind: "flat_judge",
      evidence,
      key: `flat:${flag.judgeId}`,
      judgeId: flag.judgeId,
      name: now.judges.find((j) => j.id === flag.judgeId)?.name ?? flag.judgeId,
      vector: flag.vector,
      reviews: flag.reviews,
      movesIfOut: moves,
      of: b.ranked,
      biggest,
      resolved: override ? { mode: override.mode, reason: override.reason } : null,
    });
  }

  const dismissed = new Set(event.settings.notDuplicates ?? []);
  const info = submittedProjects(db, event.id);
  const groups = new Map<string, ProjectInfo[]>();
  for (const p of info) {
    const k = `${p.teamId}\u0000${normTitle(p.typedTitle)}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  for (const copies of groups.values()) {
    if (copies.length < 2) continue;
    const ids = copies.map((c) => c.id).sort();
    const merged = copies.find((c) => c.duplicateOf);
    const allDismissed = ids.every((a, i) => ids.slice(i + 1).every((b) => dismissed.has(pairKey(a, b))));
    out.push({
      kind: "duplicate",
      key: `dup:${ids.join("|")}`,
      team: copies[0]!.teamName,
      title: copies[0]!.title,
      copies: copies.map((c) => {
        const row = now.projects.find((p) => p.id === c.id);
        return { id: c.id, title: c.title, submittedAt: c.submittedAt, repoUrl: c.repoUrl, rankRaw: row?.rankRaw ?? null, n: row?.nAll ?? 0, duplicateOf: c.duplicateOf };
      }),
      resolved: merged ? "merged" : allDismissed ? "not_duplicates" : null,
      keptId: merged?.duplicateOf ?? null,
    });
  }

  const accepted = new Set(event.settings.acceptedUnderReviewed ?? []);
  const pending = db
    .select({ projectId: assignments.projectId, judgeId: assignments.judgeUserId })
    .from(assignments)
    .where(and(eq(assignments.eventId, event.id), eq(assignments.status, "pending")))
    .all()
    .filter((a) => !now.excluded.includes(a.judgeId));
  for (const p of now.projects) {
    if (!p.underReviewed) continue;
    out.push({
      kind: "under_reviewed",
      key: `under:${p.id}`,
      projectId: p.id,
      title: p.title,
      trackName: p.trackName,
      n: p.n,
      waiting: pending.filter((a) => a.projectId === p.id).length,
      resolved: accepted.has(p.id) ? "accepted" : null,
    });
  }
  return out;
}

/**
 * The decisions that stand between an event and its published results, for how it is
 * judged: the score engine's list, or in pairwise mode the flagged judges and the
 * projects fewer than two judges compared, plus the duplicates either way.
 */
export function eventDecisions(
  db: DbOrTx,
  event: EventRow,
  runs: { normalization?: Normalized; pairwise?: PairwiseComputed } = {},
): Decision[] {
  const now = runs.normalization ?? computeNormalization(db, event);
  if (judgingModeOf(event) !== "pairwise") return decisions(db, event, now);
  const duplicates = decisions(db, event, now).filter((d) => d.kind === "duplicate");
  return [...pairwiseDecisions(event, runs.pairwise ?? computePairwise(db, event)), ...duplicates];
}

// ---------------------------------------------------------------------------
// Audited actions
// ---------------------------------------------------------------------------

export function notPublished(event: EventRow) {
  if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so the judge set and the projects are final.");
}

const Reason = z.string().trim().min(3, "say why, in a few words").max(500);
export const OverrideInput = z.object({ judgeUserId: z.string().min(1), mode: z.enum(["include", "exclude"]), reason: Reason });

/** Reinstate a flagged judge or exclude one by hand; the reason is required and audited. */
export function setJudgeOverride(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const input = parse(OverrideInput, body);
    if (!isJudgeIn(tx, input.judgeUserId, event.id)) throw new NotFoundError("Judge");
    const now = new Date().toISOString();
    const previous = tx
      .select()
      .from(judgeOverrides)
      .where(and(eq(judgeOverrides.eventId, event.id), eq(judgeOverrides.judgeUserId, input.judgeUserId), isNull(judgeOverrides.revokedAt)))
      .get();
    if (previous) {
      tx.update(judgeOverrides).set({ revokedAt: now, revokedBy: actor!.userId }).where(eq(judgeOverrides.id, previous.id)).run();
    }
    const id = newId("ovr");
    tx.insert(judgeOverrides)
      .values({ id, eventId: event.id, judgeUserId: input.judgeUserId, mode: input.mode, reason: input.reason, createdAt: now, createdBy: actor!.userId })
      .run();
    return {
      result: { id },
      audit: {
        action: "judge.override",
        eventId: event.id,
        targetType: "user",
        targetId: input.judgeUserId,
        before: previous ? { mode: previous.mode, reason: previous.reason } : null,
        after: { mode: input.mode, reason: input.reason },
      },
    };
  });
}

export const RevokeInput = z.object({ judgeUserId: z.string().min(1) });

/** Undo the active override on a judge: the flat-judge rule applies again. */
export function revokeJudgeOverride(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { judgeUserId } = parse(RevokeInput, body);
    const active = tx
      .select()
      .from(judgeOverrides)
      .where(and(eq(judgeOverrides.eventId, event.id), eq(judgeOverrides.judgeUserId, judgeUserId), isNull(judgeOverrides.revokedAt)))
      .get();
    if (!active) return { result: { revoked: false }, audit: null };
    // A removed judge's reviews stay out: they count again only once the person judges here again.
    if (!isJudgeIn(tx, judgeUserId, event.id)) {
      throw new ConflictError("judge_removed", "This judge was removed from the event, so their reviews stay out of the ranking. Invite them again first, then reinstate them with a reason.");
    }
    tx.update(judgeOverrides).set({ revokedAt: new Date().toISOString(), revokedBy: actor!.userId }).where(eq(judgeOverrides.id, active.id)).run();
    return {
      result: { revoked: true },
      audit: { action: "judge.override_revoke", eventId: event.id, targetType: "user", targetId: judgeUserId, before: { mode: active.mode, reason: active.reason } },
    };
  });
}

export const MergeInput = z.object({ keepId: z.string().min(1), duplicateId: z.string().min(1) });

/**
 * Mark one copy a duplicate of the other: the engine treats them as one project,
 * the kept copy inherits the other's reviews (a judge who scored both counts once),
 * no score row is deleted and both copies stay visible in the raw table.
 */
export function mergeDuplicate(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { keepId, duplicateId } = parse(MergeInput, body);
    if (keepId === duplicateId) throw new ConflictError("same_project", "Choose two different projects.");
    const rows = tx
      .select({ id: projects.id, duplicateOf: projects.duplicateOf, status: projects.status })
      .from(projects)
      .where(eq(projects.eventId, event.id))
      .all();
    const keep = rows.find((r) => r.id === keepId);
    const dup = rows.find((r) => r.id === duplicateId);
    if (!keep || !dup || keep.status !== "submitted" || dup.status !== "submitted") throw new NotFoundError("Submitted project");
    if (dup.duplicateOf || keep.duplicateOf) throw new ConflictError("already_merged", "One of these copies is already merged.");
    if (rows.some((r) => r.duplicateOf === duplicateId)) throw new ConflictError("already_merged", "Another copy is merged into this one; undo that first.");
    const count = countBeforeChange(tx, event);
    tx.update(projects).set({ duplicateOf: keepId }).where(eq(projects.id, duplicateId)).run();
    const countChange = recordCountChange(tx, event, count, { kind: "merge", keepId, duplicateId });
    return {
      result: { keepId, duplicateId },
      audit: { action: "project.merge", eventId: event.id, targetType: "project", targetId: duplicateId, after: { into: keepId, ...(countChange ? { countChange } : {}) } },
    };
  });
}

export const UnmergeInput = z.object({ duplicateId: z.string().min(1) });

export function unmergeDuplicate(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { duplicateId } = parse(UnmergeInput, body);
    const row = tx
      .select({ duplicateOf: projects.duplicateOf })
      .from(projects)
      .where(and(eq(projects.id, duplicateId), eq(projects.eventId, event.id)))
      .get();
    if (!row) throw new NotFoundError("Project");
    if (!row.duplicateOf) return { result: { duplicateId }, audit: null };
    const count = countBeforeChange(tx, event);
    tx.update(projects).set({ duplicateOf: null }).where(eq(projects.id, duplicateId)).run();
    const countChange = recordCountChange(tx, event, count, { kind: "unmerge", keepId: row.duplicateOf, duplicateId });
    return {
      result: { duplicateId },
      audit: {
        action: "project.unmerge",
        eventId: event.id,
        targetType: "project",
        targetId: duplicateId,
        before: { into: row.duplicateOf },
        ...(countChange ? { after: { countChange } } : {}),
      },
    };
  });
}

export const PairInput = z.object({ ids: z.array(z.string().min(1)).min(2), reason: Reason });

/** A decision names only this event's projects: any other id is a 422, never a stored string. */
function requireOwnProjects(tx: DbOrTx, event: EventRow, ids: string[]) {
  const found = new Set(
    tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.eventId, event.id), inArray(projects.id, ids)))
      .all()
      .map((p) => p.id),
  );
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ValidationError("Check the projects.", { ids: [`not a project of this event: ${missing.slice(0, 3).join(", ")}`] });
}

/** The organizer rules that same-titled projects of one team are different projects. */
export function dismissDuplicate(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { ids, reason } = parse(PairInput, body);
    const sorted = [...new Set(ids)].sort();
    requireOwnProjects(tx, event, sorted);
    const pairs = sorted.flatMap((a, i) => sorted.slice(i + 1).map((b) => pairKey(a, b)));
    const notDuplicates = [...new Set([...(event.settings.notDuplicates ?? []), ...pairs])].sort();
    tx.update(events).set({ settings: { ...event.settings, notDuplicates } }).where(eq(events.id, event.id)).run();
    return {
      result: { ids: sorted },
      audit: { action: "project.not_duplicate", eventId: event.id, targetType: "project", targetId: sorted[0]!, after: { ids: sorted, reason } },
    };
  });
}

export const UndoPairInput = z.object({ ids: z.array(z.string().min(1)).min(2) });

/** Undo "they are different projects": the copies are flagged as a duplicate again. */
export function undoNotDuplicate(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { ids } = parse(UndoPairInput, body);
    const sorted = [...new Set(ids)].sort();
    const pairs = new Set(sorted.flatMap((a, i) => sorted.slice(i + 1).map((b) => pairKey(a, b))));
    const before = event.settings.notDuplicates ?? [];
    const notDuplicates = before.filter((p) => !pairs.has(p));
    if (notDuplicates.length === before.length) return { result: { ids: sorted }, audit: null };
    tx.update(events).set({ settings: { ...event.settings, notDuplicates } }).where(eq(events.id, event.id)).run();
    return {
      result: { ids: sorted },
      audit: { action: "project.not_duplicate_undo", eventId: event.id, targetType: "project", targetId: sorted[0]!, before: { ids: sorted } },
    };
  });
}

export const AcceptInput = z.object({ projectId: z.string().min(1), reason: Reason });

/** Publish an under-reviewed project as it is; the results mark it. */
export function acceptUnderReviewed(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { projectId, reason } = parse(AcceptInput, body);
    requireOwnProjects(tx, event, [projectId]);
    const accepted = [...new Set([...(event.settings.acceptedUnderReviewed ?? []), projectId])].sort();
    tx.update(events).set({ settings: { ...event.settings, acceptedUnderReviewed: accepted } }).where(eq(events.id, event.id)).run();
    return {
      result: { projectId },
      audit: { action: "project.accept_under_reviewed", eventId: event.id, targetType: "project", targetId: projectId, after: { reason } },
    };
  });
}

export const UndoAcceptInput = z.object({ projectId: z.string().min(1) });

/** Undo "publish it as it is": the under-reviewed project is an open decision again. */
export function undoAcceptUnderReviewed(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { projectId } = parse(UndoAcceptInput, body);
    const before = event.settings.acceptedUnderReviewed ?? [];
    if (!before.includes(projectId)) return { result: { projectId }, audit: null };
    const acceptedUnderReviewed = before.filter((p) => p !== projectId);
    tx.update(events).set({ settings: { ...event.settings, acceptedUnderReviewed } }).where(eq(events.id, event.id)).run();
    return {
      result: { projectId },
      audit: { action: "project.accept_under_reviewed_undo", eventId: event.id, targetType: "project", targetId: projectId, before: { accepted: true } },
    };
  });
}

