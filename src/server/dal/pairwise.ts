import "server-only";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { authorize, type Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, comparisons, events, normalizationRuns, normalizedScores, projects, teams, tracks } from "../db/schema";
import { ConflictError } from "../errors";
import {
  COIN_FLIP_Z,
  fitPairwise,
  impliedFromScores,
  judgeAgreement,
  MIN_PICKS_FOR_FLAG,
  replayInsertion,
  TIE_RATE_FLAG,
  type Comparison,
  type PairwiseFit,
  type PickRecord,
} from "../judging/pairwise";
import { guardRead, mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { finishedReviews, inJudgeTracks, judgeNames, judgeSet, rubricOf, submittedProjects, weightedTotal, type ProjectInfo } from "./judging";
import { parse } from "./parse";
import { withoutHidden, type FieldModes } from "@/lib/project-fields";
import { fieldModes } from "./project-fields";

// Pairwise mode (JUDGING.md "Pairwise mode"; the engine is src/server/judging/pairwise.ts).
// A judge's list and next question are replayed from their own answers on every read
// and every write, so there is no second copy of that state to drift; a write must
// answer exactly the question the server would ask now (409 otherwise).

export type JudgingMode = "scores" | "pairwise";
export const judgingModeOf = (e: Pick<EventRow, "settings">): JudgingMode => (e.settings.judgingMode === "pairwise" ? "pairwise" : "scores");

export const PAIRWISE_METHOD = "bradley-terry-v1";

/** A pull is shown to people only once it is known within this many percentage points; before that the number is the prior's, not a finding. */
export const PULL_SHOWN_WITHIN = 6;

/** A pull on the logit scale as the share of wins between two equal projects, with its ± in points; `measured` once the ± is within PULL_SHOWN_WITHIN. */
export function pullShare(b: { est: number; se: number } | null): { share: number; pm: number; measured: boolean } | null {
  if (!b) return null;
  const p = 1 / (1 + Math.exp(-b.est));
  const pm = Math.max(1, Math.round(p * (1 - p) * b.se * 100));
  return { share: p, pm, measured: pm <= PULL_SHOWN_WITHIN };
}
export const PAIRWISE_METHOD_LABEL = "Bradley-Terry fit of every judge's either/or answers, with the pull of the left side and of the project just opened estimated and taken out";

function pairwiseOn(event: EventRow) {
  if (judgingModeOf(event) !== "pairwise") {
    throw new ConflictError("not_pairwise", "This event's judges score with the rubric; the organizer can switch it to pairwise in Settings.");
  }
}

export type PairwiseProject = {
  id: string;
  /** the judge's own assignment for this project (to declare a conflict) */
  assignmentId: string;
  title: string;
  summary: string;
  description: string;
  teamName: string;
  repoUrl: string | null;
  videoUrl: string | null;
  liveUrl: string | null;
  thumbnailUrl: string | null;
  tags: string[];
};

/** The session judge's own projects in pairwise mode, per track: assigned, not recused, in their tracks now, not merged away. */
function ownProjects(db: DbOrTx, eventId: string, judgeUserId: string) {
  const rows = db
    .select({
      id: projects.id,
      assignmentId: assignments.id,
      title: projects.title,
      summary: projects.summary,
      description: projects.description,
      repoUrl: projects.repoUrl,
      videoUrl: projects.videoUrl,
      liveUrl: projects.liveUrl,
      thumbnailUrl: projects.thumbnailUrl,
      tags: projects.tags,
      teamName: teams.name,
      trackId: tracks.id,
      trackName: tracks.name,
      trackPosition: tracks.position,
    })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(
      and(
        eq(assignments.eventId, eventId),
        eq(assignments.judgeUserId, judgeUserId),
        ne(assignments.status, "recused"),
        eq(projects.status, "submitted"),
        isNull(projects.duplicateOf),
        inJudgeTracks,
      ),
    )
    .orderBy(asc(tracks.position), asc(projects.id))
    .all();
  const byTrack = new Map<string, { trackId: string; trackName: string; projects: PairwiseProject[] }>();
  // what the organizer does not ask teams for is not shown to judges either
  const modes = fieldModes(db, eventId);
  for (const { trackId, trackName, trackPosition: _p, ...p } of rows) {
    const t = byTrack.get(trackId) ?? { trackId, trackName, projects: [] };
    t.projects.push(withoutHidden(p, modes));
    byTrack.set(trackId, t);
  }
  return [...byTrack.values()];
}

/** Stable per judge and project, so the order a judge opens projects in never depends on the insertion order of rows. */
function seededKey(judgeId: string, projectId: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${judgeId}#${projectId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function activePicks(db: DbOrTx, eventId: string) {
  return db
    .select()
    .from(comparisons)
    .where(and(eq(comparisons.eventId, eventId), isNull(comparisons.voidedAt)))
    // Insertion order (rowid; rows are never deleted): two answers in one millisecond still replay in the order given.
    .orderBy(asc(sql`rowid`))
    .all();
}

export type PairwiseTrackState = {
  trackId: string;
  trackName: string;
  /** every project of the judge's in this track, placed or not */
  projects: PairwiseProject[];
  /** the judge's order so far, best first */
  list: PairwiseProject[];
  current: { left: PairwiseProject; right: PairwiseProject; newId: string; question: number; ofAbout: number } | null;
  placed: number;
  total: number;
  answered: number;
};

function trackStates(db: DbOrTx, event: EventRow, judgeUserId: string): PairwiseTrackState[] {
  const all = activePicks(db, event.id);
  // Open the projects compared least so far first, so a judge who stops early still spreads their answers.
  const seen = new Map<string, number>();
  for (const c of all) for (const id of [c.leftProjectId, c.rightProjectId]) seen.set(id, (seen.get(id) ?? 0) + 1);
  return ownProjects(db, event.id, judgeUserId).map((t) => {
    const byId = new Map(t.projects.map((p) => [p.id, p]));
    const queue = [...t.projects]
      .sort((a, b) => (seen.get(a.id) ?? 0) - (seen.get(b.id) ?? 0) || seededKey(judgeUserId, a.id) - seededKey(judgeUserId, b.id))
      .map((p) => p.id);
    const mine: PickRecord[] = all
      .filter((c) => c.judgeUserId === judgeUserId && c.trackId === t.trackId)
      .map((c) => ({ left: c.leftProjectId, right: c.rightProjectId, newId: c.newProjectId, outcome: c.outcome }));
    const s = replayInsertion(judgeUserId, queue, mine);
    const asked = s.current ? mine.filter((m) => m.newId === s.current!.newId).length : 0;
    return {
      trackId: t.trackId,
      trackName: t.trackName,
      projects: t.projects,
      list: s.list.map((id) => byId.get(id)!),
      current: s.current
        ? {
            left: byId.get(s.current.left)!,
            right: byId.get(s.current.right)!,
            newId: s.current.newId,
            question: asked + 1,
            ofAbout: Math.max(asked + 1, Math.ceil(Math.log2(s.list.length + 1))),
          }
        : null,
      placed: s.placed,
      total: s.total,
      answered: mine.length,
    };
  });
}

/** Every judge's progress in pairwise mode: projects placed into their own lists, of all their projects, and answers given. */
export function pairwiseProgress(db: DbOrTx, event: EventRow): { placed: number; total: number; answers: number } {
  const judges = db.selectDistinct({ id: assignments.judgeUserId }).from(assignments).where(eq(assignments.eventId, event.id)).all();
  const sum = { placed: 0, total: 0, answers: 0 };
  for (const j of judges) {
    for (const t of trackStates(db, event, j.id)) {
      sum.placed += t.placed;
      sum.total += t.total;
      sum.answers += t.answered;
    }
  }
  return sum;
}

export type PairwiseState = {
  event: { id: string; slug: string; name: string; judgingCloseAt: string | null; resultsPublishedAt: string | null };
  judge: { id: string; name: string };
  mode: JudgingMode;
  tracks: PairwiseTrackState[];
  /** why answers cannot change now (judging closed, results published), or null */
  readOnly: string | null;
  /** what teams were asked: a hidden field is empty on every project and not listed as missing */
  fields: FieldModes;
};

/** The session judge's lists and next question in every track. */
export function getPairwiseState(actor: Actor | null, eventIdOrSlug: string): PairwiseState {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const judge = guardRead(actor, "judging.console", { kind: "event", event: eventFacts(event) });
  const mode = judgingModeOf(event);
  // A pure check (no audit row): can this judge still answer?
  const decision = authorize(judge, "pairwise.pick", { kind: "event", event: eventFacts(event) }, new Date());
  const readOnly = decision.ok ? null : decision.message;
  return {
    event: { id: event.id, slug: event.slug, name: event.name, judgingCloseAt: event.judgingCloseAt, resultsPublishedAt: event.resultsPublishedAt },
    judge: { id: judge.userId, name: judge.name },
    mode,
    tracks: mode === "pairwise" ? trackStates(db, event, judge.userId) : [],
    readOnly,
    fields: fieldModes(db, event.id),
  };
}

export const PickInput = z.object({
  trackId: z.string().min(1),
  left: z.string().min(1).describe("the project shown on the left, as the question gave it"),
  right: z.string().min(1).describe("the project shown on the right"),
  outcome: z.enum(["left", "right", "tie"]).describe("which is better; tie = too close to call"),
});
export const UndoInput = z.object({ trackId: z.string().min(1) });

/** Answer the current question in one track. Only that exact question: anything else is 409. */
export function pickPairwise(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "pairwise.pick",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      pairwiseOn(event);
      const input = parse(PickInput, body);
      const before = trackStates(tx, event, actor!.userId).find((t) => t.trackId === input.trackId);
      const q = before?.current;
      if (!q || q.left.id !== input.left || q.right.id !== input.right) {
        throw new ConflictError("question_changed", "That is not the question to answer now; reload to see the current one.");
      }
      const now = new Date().toISOString();
      tx.insert(comparisons)
        .values({
          id: newId("cmp"),
          eventId: event.id,
          judgeUserId: actor!.userId,
          trackId: input.trackId,
          leftProjectId: input.left,
          rightProjectId: input.right,
          newProjectId: q.newId,
          outcome: input.outcome,
          createdAt: now,
        })
        .run();
      const after = trackStates(tx, event, actor!.userId).find((t) => t.trackId === input.trackId)!;
      return {
        result: { trackId: input.trackId, placed: after.placed, total: after.total, done: after.current === null },
        audit: {
          action: "pairwise.pick",
          eventId: event.id,
          targetType: "project",
          targetId: q.newId,
          after: { trackId: input.trackId, left: input.left, right: input.right, outcome: input.outcome },
        },
      };
    },
  });
}

/** Take back the judge's latest answer in one track; the question comes back. */
export function undoPairwise(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "pairwise.pick",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      pairwiseOn(event);
      const input = parse(UndoInput, body);
      const last = tx
        .select()
        .from(comparisons)
        .where(
          and(
            eq(comparisons.eventId, event.id),
            eq(comparisons.judgeUserId, actor!.userId),
            eq(comparisons.trackId, input.trackId),
            isNull(comparisons.voidedAt),
          ),
        )
        .orderBy(desc(sql`rowid`))
        .get();
      if (!last) throw new ConflictError("nothing_to_undo", "There is no answer to take back in this track.");
      tx.update(comparisons).set({ voidedAt: new Date().toISOString() }).where(eq(comparisons.id, last.id)).run();
      return {
        result: { trackId: input.trackId, undone: last.id },
        audit: {
          action: "pairwise.undo",
          eventId: event.id,
          targetType: "project",
          targetId: last.newProjectId,
          before: { trackId: last.trackId, left: last.leftProjectId, right: last.rightProjectId, outcome: last.outcome },
        },
      };
    },
  });
}

export type CoinFlipFlag = {
  judgeId: string;
  name: string;
  picks: number;
  ties: number;
  /** weighted share of their answers that agree with the rest of the panel; coin flips earn 0.5 */
  share: number | null;
  z: number | null;
  why: "coin_flips" | "ties";
  resolved: { mode: "include" | "exclude"; reason: string } | null;
};

export type ReceiptLine = { judge: string; opponentId: string; opponent: string; result: "won" | "lost" | "tie"; kind: "pick" | "scores"; weight: number; side: "left" | "right" | null };

export type PairwiseComputed = {
  fit: PairwiseFit;
  info: ProjectInfo[];
  /** comparisons that entered the fit */
  used: Comparison[];
  counts: { picks: number; fromScores: number; judges: number };
  flags: CoinFlipFlag[];
  excluded: string[];
  receipts: Map<string, ReceiptLine[]>;
  /** how many different judges compared each project */
  judgesPer: Map<string, number>;
  /** the plain share of comparisons each project won (ties half), for the comparison column */
  winRate: Map<string, number>;
};

/**
 * The event's pairwise ranking from everything the judges said: their answers, and the
 * order their finished reviews give, weighted 2/k (a judge's answers in a track replace
 * their score order there). Merged duplicates count for the copy kept; excluded judges
 * (flat, or left out by the organizer) are out; the coin-flip flag is computed for the rest.
 */
/** `scoresOnly`: leave the judges' answers out and fit the reviews' orders alone (the scores-mode cross-check). */
export function computePairwise(db: DbOrTx, event: EventRow, opts: { scoresOnly?: boolean } = {}): PairwiseComputed {
  const info = submittedProjects(db, event.id);
  const canonical = new Map(info.map((p) => [p.id, p.duplicateOf ?? p.id]));
  const kept = info.filter((p) => !p.duplicateOf);
  const trackOf = new Map(kept.map((p) => [p.id, p.trackId]));
  const tracksList: { trackId: string; projectIds: string[] }[] = [];
  for (const p of kept) {
    const t = tracksList.find((x) => x.trackId === p.trackId);
    if (t) t.projectIds.push(p.id);
    else tracksList.push({ trackId: p.trackId, projectIds: [p.id] });
  }
  const names = judgeNames(db, event.id);
  const reviews = finishedReviews(db, event.id);
  const set = judgeSet(db, event.id, reviews);
  const excluded = new Set(set.excluded);

  // An answer about a project the judge has since recused from stops counting, as a recused
  // review does in scores mode (a merged copy's recusal covers the kept copy too).
  const recused = new Set(
    db
      .select({ judge: assignments.judgeUserId, project: assignments.projectId })
      .from(assignments)
      .where(and(eq(assignments.eventId, event.id), eq(assignments.status, "recused")))
      .all()
      .flatMap((r) => [`${r.judge}|${r.project}`, `${r.judge}|${canonical.get(r.project) ?? r.project}`]),
  );
  const picks: Comparison[] = [];
  for (const c of opts.scoresOnly ? [] : activePicks(db, event.id)) {
    const a = canonical.get(c.leftProjectId);
    const b = canonical.get(c.rightProjectId);
    if (!a || !b || a === b || trackOf.get(a) !== trackOf.get(b)) continue;
    if ([c.leftProjectId, c.rightProjectId, a, b].some((p) => recused.has(`${c.judgeUserId}|${p}`))) continue;
    picks.push({
      judgeId: c.judgeUserId,
      trackId: trackOf.get(a)!,
      a,
      b,
      y: c.outcome === "left" ? 1 : c.outcome === "right" ? 0 : 0.5,
      weight: 1,
      kind: "pick",
      newIs: c.newProjectId === c.leftProjectId ? "a" : "b",
    });
  }
  // A judge's picks replace their score order for the pairs they cover (both projects placed by picks).
  const covered = new Map<string, Set<string>>();
  for (const c of picks) {
    const key = `${c.judgeId}|${c.trackId}`;
    const set = covered.get(key) ?? new Set<string>();
    set.add(c.a).add(c.b);
    covered.set(key, set);
  }
  const criteria = rubricOf(db, event.id);
  // A judge who scored both copies of a merged duplicate counts once for the kept copy, their
  // totals averaged, as in scores mode; otherwise that judge's order would hold the project twice.
  const perJudgeProject = new Map<string, { judgeId: string; trackId: string; projectId: string; sum: number; n: number }>();
  for (const r of reviews) {
    const projectId = canonical.get(r.projectId);
    if (!projectId || !trackOf.has(projectId)) continue;
    const key = `${r.judgeId}|${projectId}`;
    const row = perJudgeProject.get(key) ?? { judgeId: r.judgeId, trackId: trackOf.get(projectId)!, projectId, sum: 0, n: 0 };
    row.sum += weightedTotal(criteria, r.values);
    row.n += 1;
    perJudgeProject.set(key, row);
  }
  const implied = impliedFromScores(
    [...perJudgeProject.values()].map((r) => ({ judgeId: r.judgeId, trackId: r.trackId, projectId: r.projectId, total: r.sum / r.n })),
    covered,
  );
  const all = [...picks, ...implied];
  const used = all.filter((c) => !excluded.has(c.judgeId));

  const overrides = new Map(set.overrides.map((o) => [o.judgeId, o]));
  const flags: CoinFlipFlag[] = [];
  const pickers = [...new Set(picks.map((c) => c.judgeId))].filter((j) => !excluded.has(j) || overrides.get(j)?.mode === "exclude");
  for (const j of pickers) {
    // A judge the organizer left out is judged against everyone else still in.
    const a = judgeAgreement(tracksList, [...used.filter((c) => c.judgeId !== j), ...all.filter((c) => c.judgeId === j)], j);
    if (a.picks < MIN_PICKS_FOR_FLAG) continue;
    const coin = a.z !== null && a.z < COIN_FLIP_Z;
    const ties = a.ties / a.picks > TIE_RATE_FLAG;
    if (!coin && !ties) continue;
    const o = overrides.get(j);
    flags.push({
      judgeId: j,
      name: names.get(j) ?? j,
      picks: a.picks,
      ties: a.ties,
      share: a.share,
      z: a.z,
      why: coin ? "coin_flips" : "ties",
      resolved: o ? { mode: o.mode, reason: o.reason } : null,
    });
  }

  const fit = fitPairwise(tracksList, used);
  const titles = new Map(kept.map((p) => [p.id, p.title]));
  const receipts = new Map<string, ReceiptLine[]>();
  const judgesSeen = new Map<string, Set<string>>();
  const won = new Map<string, number>();
  const played = new Map<string, number>();
  for (const c of used) {
    for (const [me, other, sign] of [
      [c.a, c.b, 1],
      [c.b, c.a, -1],
    ] as const) {
      const result = c.y === 0.5 ? "tie" : (c.y === 1) === (sign === 1) ? "won" : "lost";
      const line: ReceiptLine = {
        judge: names.get(c.judgeId) ?? c.judgeId,
        opponentId: other,
        opponent: titles.get(other) ?? other,
        result,
        kind: c.kind,
        weight: c.weight,
        side: c.kind === "pick" ? (sign === 1 ? "left" : "right") : null,
      };
      receipts.set(me, [...(receipts.get(me) ?? []), line]);
      judgesSeen.set(me, (judgesSeen.get(me) ?? new Set()).add(c.judgeId));
      won.set(me, (won.get(me) ?? 0) + c.weight * (result === "won" ? 1 : result === "tie" ? 0.5 : 0));
      played.set(me, (played.get(me) ?? 0) + c.weight);
    }
  }
  return {
    fit,
    info,
    used,
    counts: { picks: used.filter((c) => c.kind === "pick").length, fromScores: used.filter((c) => c.kind === "scores").length, judges: new Set(used.map((c) => c.judgeId)).size },
    flags,
    excluded: [...excluded],
    receipts,
    judgesPer: new Map([...judgesSeen].map(([id, s]) => [id, s.size])),
    winRate: new Map([...played].map(([id, n]) => [id, n > 0 ? won.get(id)! / n : 0])),
  };
}

export type PairwiseRanking = {
  mode: JudgingMode;
  method: string;
  counts: PairwiseComputed["counts"];
  left: PairwiseFit["left"];
  fresh: PairwiseFit["fresh"];
  flags: CoinFlipFlag[];
  /** judges whose answers and scores are out of the fit: the flat-judge rule or an organizer's decision */
  leftOut: string[];
  tracks: {
    trackId: string;
    name: string;
    groups: number;
    rows: {
      projectId: string;
      title: string;
      teamName: string;
      place: number;
      winPct: number;
      winPctSe: number;
      winRate: number | null;
      comparisons: number;
      picks: number;
      judges: number;
      beatsNext: number | null;
      group: number;
      receipt: ReceiptLine[];
    }[];
  }[];
};

/** The organizer's pairwise ranking, live: the fit, the two pulls, the flags and every project's receipt. */
export function getPairwiseRanking(actor: Actor | null, eventIdOrSlug: string): PairwiseRanking {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const pw = computePairwise(db, event);
  const byId = new Map(pw.info.map((p) => [p.id, p]));
  const trackNames = new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).all().map((t) => [t.id, t.name]));
  return {
    mode: judgingModeOf(event),
    method: PAIRWISE_METHOD_LABEL,
    counts: pw.counts,
    left: pw.fit.left,
    fresh: pw.fit.fresh,
    flags: pw.flags,
    leftOut: (() => {
      const names = judgeNames(db, event.id);
      return pw.excluded.map((id) => names.get(id) ?? id).sort();
    })(),
    tracks: pw.fit.tracks.map((t) => ({
      trackId: t.trackId,
      name: trackNames.get(t.trackId) ?? t.trackId,
      groups: t.groups,
      rows: pw.fit.projects
        .filter((p) => p.trackId === t.trackId)
        .map((p) => ({
          projectId: p.id,
          title: byId.get(p.id)?.title ?? p.id,
          teamName: byId.get(p.id)?.teamName ?? "",
          place: p.place,
          winPct: p.winPct,
          winPctSe: p.winPctSe,
          winRate: pw.winRate.get(p.id) ?? null,
          comparisons: p.comparisons,
          picks: p.picks,
          judges: pw.judgesPer.get(p.id) ?? 0,
          beatsNext: p.beatsNext,
          group: p.group,
          receipt: pw.receipts.get(p.id) ?? [],
        })),
    })),
  };
}

export const ModeInput = z.object({
  mode: z.enum(["scores", "pairwise"]),
  reason: z.string().trim().min(3, "say why, in a few words").max(500),
});

/** How the event's judges judge. Organizer only, with a reason, until results are published. */
export function setJudgingMode(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      const input = parse(ModeInput, body);
      if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so how the event was judged is final.");
      const before = judgingModeOf(event);
      if (before === input.mode) return { result: { mode: before, changed: false }, audit: null };
      tx.update(events)
        .set({ settings: { ...event.settings, judgingMode: input.mode } })
        .where(eq(events.id, event.id))
        .run();
      return {
        result: { mode: input.mode, changed: true },
        audit: { action: "event.judging_mode", eventId: event.id, targetType: "event", targetId: event.id, before: { mode: before }, after: { mode: input.mode, reason: input.reason } },
      };
    },
  });
}

export type CoinFlipDecision = { kind: "coin_flip_judge"; key: string } & CoinFlipFlag;
export type UnderComparedDecision = {
  kind: "under_reviewed";
  key: string;
  projectId: string;
  title: string;
  trackName: string;
  /** in pairwise mode: how many different judges compared it */
  n: number;
  waiting: number;
  resolved: "accepted" | null;
  mode: "pairwise";
};

/**
 * What the organizer must settle before publishing a pairwise event (duplicates come
 * from the shared list): each flagged judge, kept or left out with a reason, and each
 * project fewer than two judges compared, published as it is with a reason.
 */
export function pairwiseDecisions(event: EventRow, pw: PairwiseComputed): (CoinFlipDecision | UnderComparedDecision)[] {
  const accepted = new Set(event.settings.acceptedUnderReviewed ?? []);
  return [
    ...pw.flags.map((f) => ({ kind: "coin_flip_judge" as const, key: `coin:${f.judgeId}`, ...f })),
    ...pw.info
      .filter((p) => !p.duplicateOf && (pw.judgesPer.get(p.id) ?? 0) < 2)
      .map((p) => ({
        kind: "under_reviewed" as const,
        key: `under:${p.id}`,
        projectId: p.id,
        title: p.title,
        trackName: p.trackName,
        n: pw.judgesPer.get(p.id) ?? 0,
        waiting: 0,
        resolved: accepted.has(p.id) ? ("accepted" as const) : null,
        mode: "pairwise" as const,
      })),
  ];
}

/** Store the ranking a pairwise event publishes, in the same tables as a score run, so results, records and exports read it the same way. */
export function storePairwiseRun(tx: DbOrTx, event: EventRow, actorId: string, pw: PairwiseComputed, at: string): string {
  const id = newId("nrm");
  tx.insert(normalizationRuns)
    .values({
      id,
      eventId: event.id,
      method: PAIRWISE_METHOD,
      params: {
        left: pw.fit.left,
        fresh: pw.fit.fresh,
        counts: pw.counts,
        excluded: pw.excluded,
        flags: pw.flags.map((f) => ({ judgeId: f.judgeId, why: f.why, picks: f.picks, ties: f.ties, z: f.z, resolved: f.resolved })),
        groups: pw.fit.tracks,
        converged: pw.fit.converged,
      },
      computedAt: at,
      computedBy: actorId,
    })
    .run();
  const compared = pw.fit.projects.filter((p) => p.comparisons > 0);
  const rankBy = (value: (p: (typeof compared)[number]) => number) => {
    const sorted = [...compared].sort((a, b) => value(b) - value(a));
    return new Map(sorted.map((p, i) => [p.id, i + 1]));
  };
  const overall = rankBy((p) => p.winPct);
  const plain = rankBy((p) => pw.winRate.get(p.id) ?? 0);
  for (const p of pw.fit.projects) {
    const has = p.comparisons > 0;
    tx.insert(normalizedScores)
      .values({
        runId: id,
        projectId: p.id,
        // judges who compared it: the pairwise counterpart of a project's reviews
        n: pw.judgesPer.get(p.id) ?? 0,
        rawMean: has ? (pw.winRate.get(p.id) ?? null) : null,
        normalizedMean: has ? p.winPct : null,
        se: has ? p.winPctSe : null,
        rankRaw: has ? (plain.get(p.id) ?? null) : null,
        rankNormalized: has ? (overall.get(p.id) ?? null) : null,
      })
      .run();
  }
  return id;
}
