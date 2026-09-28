import "server-only";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, auditLog, events, normalizationRuns, normalizedScores, projects, scoreComments, scores, teams, tracks, users } from "../db/schema";
import type { ChainAnchor } from "../audit";
import { formatUtc } from "@/lib/format";
import { ConflictError } from "../errors";
import { averageRanks } from "../judging/normalize";
import type { Yardstick } from "../judging/yardstick";
import { guardRead } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { endVoteForPublish } from "./voting";
import { judgeSet } from "./judging";
import { computePairwise, judgingModeOf, PAIRWISE_METHOD, storePairwiseRun } from "./pairwise";
import { METHOD, METHOD_LABEL, type ProjectRow, type Normalized, computeNormalization } from "./normalization";
import { decisions, eventDecisions, organizerMutation, notPublished } from "./decisions";

// The organizer's results view (the normalization, its decisions, the judges' private notes
// and the cross-check between methods), publishing, which stores the run it publishes, and
// the published results everyone reads.

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type PrivateNote = { projectId: string; judgeId: string; judge: string; note: string };

/** The judges' private notes to the organizers, keyed to the project row that shows them (a merged copy's go to the copy kept). */
function privateNotes(db: DbOrTx, eventId: string, rows: ProjectRow[]): PrivateNote[] {
  const canonical = new Map(rows.map((p) => [p.id, p.duplicateOf ?? p.id]));
  return db
    .select({ projectId: assignments.projectId, judgeId: assignments.judgeUserId, judge: users.name, note: scoreComments.privateNote })
    .from(scoreComments)
    .innerJoin(scores, eq(scores.id, scoreComments.scoreId))
    .innerJoin(assignments, eq(assignments.id, scores.assignmentId))
    .innerJoin(users, eq(users.id, assignments.judgeUserId))
    .where(and(eq(assignments.eventId, eventId), ne(scoreComments.privateNote, "")))
    .orderBy(asc(users.name))
    .all()
    .filter((n) => canonical.has(n.projectId))
    .map((n) => ({ ...n, projectId: canonical.get(n.projectId)! }));
}

export function getNormalization(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const now = computeNormalization(db, event, { signal: true, influence: true });
  return {
    event,
    method: METHOD_LABEL,
    normalization: now,
    decisions: decisions(db, event, now),
    notes: privateNotes(db, event.id, now.projects),
    crossCheck: judgingModeOf(event) === "scores" ? crossCheck(db, event, now.projects) : null,
  };
}

/** Kendall's tau-b of two orders of the same items (lower is better in both); null when either order is all ties. */
export function kendallTauB(a: number[], b: number[]): number | null {
  let concordant = 0;
  let discordant = 0;
  let tiesA = 0;
  let tiesB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const x = Math.sign(a[i]! - a[j]!);
      const y = Math.sign(b[i]! - b[j]!);
      if (x === 0 && y === 0) continue;
      if (x === 0) tiesA++;
      else if (y === 0) tiesB++;
      else if (x === y) concordant++;
      else discordant++;
    }
  }
  const den = Math.sqrt((concordant + discordant + tiesA) * (concordant + discordant + tiesB));
  return den === 0 ? null : (concordant - discordant) / den;
}

export type CrossCheck = {
  tracks: { trackId: string; name: string; projects: number; tau: number | null; movers: { id: string; title: string; normalized: number; pairwise: number }[] }[];
  /** tau across tracks, each weighted by its projects */
  overall: number | null;
};

/**
 * A second opinion on a scores-mode ranking from the same reviews: the pairwise engine
 * reads each judge's reviews only as their order of their own projects (JUDGING.md,
 * "Pairwise mode"), so no judge's scale can move it. Per track: how far the two
 * orders agree (Kendall's tau-b) and the projects whose places differ most.
 */
function crossCheck(db: DbOrTx, event: EventRow, rows: ProjectRow[]): CrossCheck {
  const pw = computePairwise(db, event, { scoresOnly: true });
  const place = new Map(pw.fit.projects.filter((p) => p.comparisons > 0).map((p) => [p.id, p.place]));
  const byTrack = new Map<string, ProjectRow[]>();
  for (const r of rows) {
    if (r.duplicateOf || r.trackRank === null || !place.has(r.id)) continue;
    byTrack.set(r.trackId, [...(byTrack.get(r.trackId) ?? []), r]);
  }
  const tracksOut = [...byTrack.values()].map((list) => {
    const tau = kendallTauB(
      list.map((r) => r.trackRank!),
      list.map((r) => place.get(r.id)!),
    );
    const movers = list
      .map((r) => ({ id: r.id, title: r.title, normalized: r.trackRank!, pairwise: place.get(r.id)! }))
      .filter((m) => Math.abs(m.normalized - m.pairwise) >= 1)
      .sort((x, y) => Math.abs(y.normalized - y.pairwise) - Math.abs(x.normalized - x.pairwise) || x.title.localeCompare(y.title))
      .slice(0, 3);
    return { trackId: list[0]!.trackId, name: list[0]!.trackName, projects: list.length, tau, movers };
  });
  const weighted = tracksOut.filter((t) => t.tau !== null);
  const total = weighted.reduce((n, t) => n + t.projects, 0);
  return {
    tracks: tracksOut,
    overall: total ? weighted.reduce((sum, t) => sum + t.tau! * t.projects, 0) / total : null,
  };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

function storeRun(tx: DbOrTx, event: EventRow, actor: Actor, n: Normalized, at: string): string {
  const set = judgeSet(tx, event.id);
  const id = newId("nrm");
  tx.insert(normalizationRuns)
    .values({
      id,
      eventId: event.id,
      method: METHOD,
      params: {
        ...n.variance,
        excluded: n.excluded,
        flags: set.flags,
        overrides: set.overrides.map((o) => ({ judgeId: o.judgeId, mode: o.mode, reason: o.reason, at: o.createdAt })),
        merges: n.projects.filter((p) => p.duplicateOf).map((p) => ({ duplicate: p.id, into: p.duplicateOf })),
        judges: n.judges.filter((j) => !j.excluded && j.n > 0).map((j) => ({ id: j.id, n: j.n, leniency: j.leniency })),
        ranked: n.ranked,
        moved: n.moved,
        signal: n.signal,
        yardstick: n.yardstick,
      },
      computedAt: at,
      computedBy: actor.userId,
    })
    .run();
  for (const p of n.projects) {
    if (p.duplicateOf) continue;
    tx.insert(normalizedScores)
      .values({ runId: id, projectId: p.id, n: p.n, rawMean: p.rawAll, normalizedMean: p.score, se: p.se, rankRaw: p.rankRaw, rankNormalized: p.rankNormalized })
      .run();
  }
  return id;
}

/**
 * Publish results: only when every decision is settled. Stores the normalization
 * run it publishes, so the results page shows exactly what was decided.
 */
export function publishResults(actor: Actor | null, eventIdOrSlug: string) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    // A project sent after publishing would be missing from the published results, and
    // the dates are final from then on, so the window could no longer be closed early.
    if (Date.now() < Date.parse(event.submissionsCloseAt)) {
      throw new ConflictError(
        "submissions_open",
        `Submissions are open until ${formatUtc(event.submissionsCloseAt)}. Results can be published once they close.`,
      );
    }
    const at = new Date().toISOString();
    if (judgingModeOf(event) === "pairwise") {
      const openPw = eventDecisions(tx, event).filter((d) => !d.resolved);
      if (openPw.length) {
        throw new ConflictError("decisions_open", `${openPw.length} ${openPw.length === 1 ? "decision is" : "decisions are"} still open. Settle ${openPw.length === 1 ? "it" : "them"} before publishing.`);
      }
      const pw = computePairwise(tx, event);
      const pwRun = storePairwiseRun(tx, event, actor!.userId, pw, at);
      const vote = endVoteForPublish(tx, event, at);
      tx.update(events)
        .set({ resultsPublishedAt: at, settings: { ...event.settings, publishedRunId: pwRun } })
        .where(eq(events.id, event.id))
        .run();
      return {
        result: { runId: pwRun, publishedAt: at },
        audit: {
          action: "results.publish",
          eventId: event.id,
          targetType: "normalization_run",
          targetId: pwRun,
          before: vote ? { voting: vote.before } : undefined,
          after: {
            method: PAIRWISE_METHOD,
            counts: pw.counts,
            left: pw.fit.left,
            fresh: pw.fit.fresh,
            excluded: pw.excluded,
            ...(vote ? { voteEnded: vote.ended, voting: vote.after } : {}),
          },
        },
      };
    }
    const n = computeNormalization(tx, event, { signal: true });
    const open = decisions(tx, event, n).filter((d) => !d.resolved);
    if (open.length) {
      throw new ConflictError("decisions_open", `${open.length} ${open.length === 1 ? "decision is" : "decisions are"} still open. Settle ${open.length === 1 ? "it" : "them"} before publishing.`);
    }
    const runId = storeRun(tx, event, actor!, n, at);
    const vote = endVoteForPublish(tx, event, at);
    tx.update(events)
      .set({ resultsPublishedAt: at, settings: { ...event.settings, publishedRunId: runId } })
      .where(eq(events.id, event.id))
      .run();
    return {
      result: { runId, publishedAt: at },
      audit: {
        action: "results.publish",
        eventId: event.id,
        targetType: "normalization_run",
        targetId: runId,
        before: vote ? { voting: vote.before } : undefined,
        after: {
          k: n.variance.k,
          beta2: n.variance.beta2,
          sigma2: n.variance.sigma2,
          ranked: n.ranked,
          excluded: n.excluded,
          ...(vote ? { voteEnded: vote.ended, voting: vote.after } : {}),
        },
      },
    };
  });
}

export type PublishedResults =
  | { published: false }
  | {
      published: true;
      publishedAt: string;
      runId: string;
      /** the audit log entry that published the run: a later rewrite of the log changes its hash */
      anchor: ChainAnchor | null;
      /** how the stored run was made: the score engine's method, or PAIRWISE_METHOD */
      method: string;
      k: number | null;
      /** the organizers' yardstick as the published run measured it; null for pairwise runs and runs stored before it existed */
      yardstick: Yardstick | null;
      tracks: {
        id: string;
        name: string;
        rows: {
          projectId: string;
          title: string;
          teamName: string;
          n: number;
          score: number | null;
          /** one standard error of the score, as stored with the run */
          se: number | null;
          raw: number | null;
          place: number | null;
          rankOverall: number | null;
        }[];
      }[];
    };

/** The published ranking, per track, from the stored run. Public. */
export function getPublishedResults(eventIdOrSlug: string): PublishedResults {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const runId = event.settings.publishedRunId;
  if (!event.resultsPublishedAt || !runId) return { published: false };
  const run = db.select().from(normalizationRuns).where(eq(normalizationRuns.id, runId)).get();
  if (!run) return { published: false };
  const rows = db
    .select({
      projectId: normalizedScores.projectId,
      n: normalizedScores.n,
      score: normalizedScores.normalizedMean,
      se: normalizedScores.se,
      raw: normalizedScores.rawMean,
      rankOverall: normalizedScores.rankNormalized,
      title: projects.title,
      teamName: teams.name,
      trackId: tracks.id,
      trackName: tracks.name,
      position: tracks.position,
    })
    .from(normalizedScores)
    .innerJoin(projects, eq(projects.id, normalizedScores.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(eq(normalizedScores.runId, runId))
    .orderBy(asc(tracks.position), desc(normalizedScores.normalizedMean))
    .all();
  const byTrack = new Map<string, { id: string; name: string; rows: typeof rows }>();
  for (const r of rows) {
    const t = byTrack.get(r.trackId) ?? { id: r.trackId, name: r.trackName, rows: [] };
    t.rows.push(r);
    byTrack.set(r.trackId, t);
  }
  const anchor =
    db
      .select({ entry: auditLog.id, hash: auditLog.hash })
      .from(auditLog)
      .where(and(eq(auditLog.action, "results.publish"), eq(auditLog.targetId, runId)))
      .orderBy(desc(auditLog.id))
      .get() ?? null;
  return {
    published: true,
    publishedAt: event.resultsPublishedAt,
    runId,
    anchor,
    method: run.method,
    k: (run.params as { k?: number | null }).k ?? null,
    yardstick: (run.params as { yardstick?: Yardstick | null }).yardstick ?? null,
    tracks: [...byTrack.values()].map((t) => {
      const places = averageRanks(new Map(t.rows.filter((r) => r.score !== null).map((r) => [r.projectId, r.score!])));
      return {
        id: t.id,
        name: t.name,
        rows: t.rows.map((r) => ({
          projectId: r.projectId,
          title: r.title,
          teamName: r.teamName,
          n: r.n,
          score: r.score,
          se: r.se,
          raw: r.raw,
          place: places.get(r.projectId) ?? null,
          rankOverall: r.rankOverall,
        })),
      };
    }),
  };
}
