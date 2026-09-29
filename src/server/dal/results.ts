import "server-only";
import { CORRECTED_FROM } from "@/lib/ranking-evidence";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { compareNames } from "@/lib/names";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, auditLog, events, normalizationRuns, normalizedScores, projects, scoreComments, scores, teams, tracks, users, type WeightChange } from "../db/schema";
import type { ChainAnchor } from "../audit";
import { formatUtc } from "@/lib/format";
import { competitionPlaceOf, competitionPlaces } from "@/lib/places";
import { ConflictError } from "../errors";
import { averageRanks, type SignalCheck } from "../judging/normalize";
import type { Bias } from "../judging/pairwise";
import type { Yardstick } from "../judging/yardstick";
import { guardRead } from "../mutate";
import { newId } from "../util";
import { eventFacts, organizerMutation, requireEvent, type EventRow } from "./events";
import { endVoteForPublish } from "./voting-organizer";
import { judgeSet } from "./judging";
import { computePairwise, judgingModeOf, PAIRWISE_METHOD, pullShare, storePairwiseRun, type Unsettled } from "./pairwise";
import { parse } from "./parse";
import { METHOD, METHOD_LABEL, type ProjectRow, type Normalized, computeNormalization } from "./normalization";
import { decisions, eventDecisions, notPublished } from "./decisions";
import { appliedDecisions, closeCallsOf, type AppliedDecision } from "./close-calls";
import { withDecidedWinner } from "../judging/decision";
import { shownTitle } from "./project-fields";
import { projectTrackMoves, type PublishedTrackMove } from "./corrections";
import { organizerChangesAfterCloseByProject } from "./teams";
import { tieBreakOf, type TieBreakView } from "./tiebreak";
import { breakTies } from "../judging/tiebreak";
import type { TieBreakChange } from "../db/schema";

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
    .sort((x, y) => compareNames(x.judge, y.judge))
    .filter((n) => canonical.has(n.projectId))
    .map((n) => ({ ...n, projectId: canonical.get(n.projectId)! }));
}

/**
 * After publishing, how the live view (worked out again on every read) stands against the run that was
 * published (normalized.csv and the public results read that one): the projects whose score or rank differ.
 * Nothing the ranking reads can change once published, so this is empty unless the engine itself changed
 * since (a later portal version) or the data was edited outside the portal; the page says so instead of
 * calling a different ranking the published one. Null before publishing, or for a pairwise run.
 */
export type PublishedCheck = { runId: string; computedAt: string; differs: { id: string; title: string; published: number | null; now: number | null }[] };

function publishedCheck(db: DbOrTx, event: EventRow, now: Normalized): PublishedCheck | null {
  const runId = event.settings.publishedRunId;
  if (!event.resultsPublishedAt || !runId) return null;
  const run = db.select({ method: normalizationRuns.method, at: normalizationRuns.computedAt }).from(normalizationRuns).where(eq(normalizationRuns.id, runId)).get();
  if (!run || run.method !== METHOD) return null;
  const stored = new Map(
    db
      .select({ id: normalizedScores.projectId, score: normalizedScores.normalizedMean, rank: normalizedScores.rankNormalized })
      .from(normalizedScores)
      .where(eq(normalizedScores.runId, runId))
      .all()
      .map((r) => [r.id, r]),
  );
  const live = now.projects.filter((p) => !p.duplicateOf);
  const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
  const differs = live
    .filter((p) => {
      const s = stored.get(p.id);
      return !s || !close(s.score, p.score) || s.rank !== p.rankNormalized;
    })
    .map((p) => ({ id: p.id, title: p.title, published: stored.get(p.id)?.rank ?? null, now: p.rankNormalized }));
  const liveIds = new Set(live.map((p) => p.id));
  for (const [id, s] of stored) if (!liveIds.has(id)) differs.push({ id, title: id, published: s.rank, now: null });
  return { runId, computedAt: run.at, differs };
}

export function getNormalization(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const now = computeNormalization(db, event, { signal: true, influence: true });
  const tieBreak = tieBreakOf(db, event, now);
  return {
    event,
    method: METHOD_LABEL,
    normalization: now,
    published: publishedCheck(db, event, now),
    decisions: decisions(db, event, now),
    /** every track whose top is too close to call, or that holds a close-call choice: advisory ones too */
    closeCalls: closeCallsOf(db, event, now).filter((c) => !c.callable || c.choice),
    notes: privateNotes(db, event.id, now.projects),
    crossCheck: judgingModeOf(event) === "scores" ? crossCheck(db, event, now.projects) : null,
    /** the event's tie-break over the live ranking, only when one is set (never in pairwise mode), so the answer is as before without one */
    ...(tieBreak ? { tieBreak } : {}),
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
 * reads each judge's reviews only as their order of the projects they were given (JUDGING.md,
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

function storeRun(tx: DbOrTx, event: EventRow, actor: Actor, n: Normalized, at: string, tie: TieBreakView | null, judgesDecisions: AppliedDecision[] = []): string {
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
        trackMoves: projectTrackMoves(tx, event.id),
        judges: n.judges.filter((j) => !j.excluded && j.n > 0).map((j) => ({ id: j.id, n: j.n, leniency: j.leniency })),
        ranked: n.ranked,
        moved: n.moved,
        signal: n.signal,
        yardstick: n.yardstick,
        // the tie-break stage, only when the event sets one: the criterion and each tied project's figure on it
        ...(tie ? { tieBreak: storedTieBreak(tie) } : {}),
        // the engine's table beyond what normalized_scores holds, in its order: normalized.csv after publishing is this run
        table: n.projects.map((p) => ({
          id: p.id,
          duplicateOf: p.duplicateOf,
          nAll: p.nAll,
          rawKept: p.rawKept,
          rankKept: p.rankKept,
          trackRank: p.trackRank,
          underReviewed: p.underReviewed,
          // a merged copy has no normalized_scores row: its own counts go here
          ...(p.duplicateOf ? { n: p.n, rawAll: p.rawAll } : {}),
        })),
        // the judges' decisions on close calls this run publishes; absent when there is none, so such a run is what it always was
        ...(judgesDecisions.length ? { judgesDecisions } : {}),
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

export const PublishInput = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "say why, in a few words")
    .max(500)
    .optional()
    .describe("needed only when a pairwise ranking fit did not settle (409 fit_not_settled without it); stored with the run and shown on the results"),
});

/**
 * Publish results: only when every decision is settled. Stores the normalization
 * run it publishes, so the results page shows exactly what was decided. A pairwise
 * fit that stopped before settling is published only with a written reason.
 */
export function publishResults(actor: Actor | null, eventIdOrSlug: string, body: unknown = {}) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const input = parse(PublishInput, body ?? {});
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
      // One fit: the decisions are checked on the run that is then stored.
      const pw = computePairwise(tx, event);
      const openPw = eventDecisions(tx, event, { pairwise: pw }).filter((d) => !d.resolved);
      if (openPw.length) {
        throw new ConflictError("decisions_open", `${openPw.length} ${openPw.length === 1 ? "decision is" : "decisions are"} still open. Settle ${openPw.length === 1 ? "it" : "them"} before publishing.`);
      }
      let unsettled: Unsettled | null = null;
      if (!pw.fit.converged) {
        if (!input.reason) {
          throw new ConflictError(
            "fit_not_settled",
            `The ranking fit did not settle within ${pw.fit.iterations} steps, so its win % may still move. More comparisons usually settle it; to publish it as it is, give a reason.`,
          );
        }
        unsettled = { iterations: pw.fit.iterations, reason: input.reason };
      }
      const pwRun = storePairwiseRun(tx, event, actor!.userId, pw, at, unsettled);
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
            converged: pw.fit.converged,
            ...(unsettled ? { unsettled } : {}),
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
    const tie = tieBreakOf(tx, event, n);
    const applied = appliedDecisions(closeCallsOf(tx, event, n));
    const runId = storeRun(tx, event, actor!, n, at, tie, applied);
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
          ...(tie ? { tieBreak: auditedTieBreak(tie) } : {}),
          ...(applied.length ? { judgesDecisions: applied.map((d) => ({ trackId: d.trackId, winnerId: d.winnerId })) } : {}),
          ...(vote ? { voteEnded: vote.ended, voting: vote.after } : {}),
        },
      },
    };
  });
}

/**
 * What a published run keeps of the tie-break: the criterion, and the figure of every project in an exact score tie
 * (a list, not an object keyed by id, so an event file's import renames the project ids in it as in the rest of the run).
 */
export type StoredTieBreak = { criterionId: string; label: string; figures: { id: string; figure: number }[] };

function storedTieBreak(tie: TieBreakView): StoredTieBreak {
  const figures = tie.groups.flatMap((g) => g.projects.flatMap((p) => (p.figure === null ? [] : [{ id: p.id, figure: p.figure }])));
  return { criterionId: tie.criterion.id, label: tie.criterion.label, figures };
}

/** The publish row's account of the tie-break: each exact tie, by track, with each project's figure and place. */
function auditedTieBreak(tie: TieBreakView) {
  return {
    criterion: tie.criterion.label,
    ties: tie.groups.map((g) => ({
      track: g.trackName,
      score: Number(g.score.toFixed(4)),
      broken: g.broken,
      projects: g.projects.map((p) => ({ id: p.id, title: p.title, figure: p.figure === null ? null : Number(p.figure.toFixed(4)), place: p.place })),
    })),
  };
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
      /** weight changes made after judging began, each with its reason; empty when no weight moved after the first score */
      weightChanges: WeightChange[];
      /** projects the organizers moved to another track after judges were assigned, oldest first, as the run stored them; empty for runs stored before moves were kept */
      trackMoves: PublishedTrackMove[];
      /** a pairwise fit that had not settled when it was published, with the organizer's reason; null otherwise */
      unsettled: Unsettled | null;
      /** only when the event broke exact ties by a criterion: its name (rows then carry tie and tieBroken) */
      tieBreak?: { criterion: string };
      /** only when the tie-break changed after judging began, whatever it ended on (joint places too): each change with its reason */
      tieBreakChanges?: TieBreakChange[];
      /** how the ranking was reached, in aggregate numbers only: never a judge's id, name or own figure */
      evidence: RankingEvidence;
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
          /** when the organizers last changed this project's team after submissions closed (renamed it, added or took off a member); null when they did not */
          teamChangedAt: string | null;
          /** with a tie-break only: the project's figure on the criterion when its score is exactly tied with another's, else null */
          tie?: number | null;
          /** with a tie-break only: the criterion split this project's exact score tie */
          tieBroken?: boolean;
          /** set only on a track's first row when the judges' decision named it the winner */
          decided?: true;
        }[];
        /** set only when the judges' decision named this track's winner on a close call: their reason, the score order and the close projects' chances */
        decision?: PublishedDecision;
      }[];
    };

/** A judges' decision as the published results show it. */
export type PublishedDecision = {
  winnerId: string;
  reason: string;
  at: string;
  /** the track's projects by score alone, best first */
  scoreOrder: string[];
  /** the close projects and their chances of being first by the scores, highest first */
  close: { id: string; title: string; p: number }[];
};

/** A pull the pairwise fit measured and corrected for, as the share of wins it gives between two equal projects; null until it is measured. */
type Pull = { share: number; pm: number } | null;

/**
 * The public "how this ranking was reached" numbers. Every one is read from the stored run or
 * counted over the published rows; none identifies a judge. `moved` compares each project's place
 * in its track with its place by the plain figure beside it (every review's plain average, or
 * the plain share of wins), so it says how much the method changed the order.
 */
export type RankingEvidence = {
  /** projects with a published score, and how many of them the method put at a different place in their track than the plain figure does */
  placed: number;
  moved: number;
  /** judges the method left out as a whole (the flat-judge or coin-flip rule, or an organizer's decision) */
  excluded: number;
} & (
  | {
      kind: "scores";
      /** null when the judges show no steady leniency: nothing is corrected */
      k: number | null;
      /** counted judges, those corrected by at least CORRECTED_FROM, and the largest and median correction in size; null in runs stored before the judges were */
      judges: { counted: number; corrected: number; largest: number; median: number } | null;
      /** the permutation signal check as stored; null when it did not run */
      signal: { share: number; trials: number } | null;
    }
  | {
      kind: "pairwise";
      answers: number;
      fromScores: number;
      judges: number;
      left: Pull;
      fresh: Pull;
      /** tracks whose answers form more than one group never compared with each other, by name; null when every track is connected */
      split: { track: string; groups: number }[] | null;
    }
);

/** A leniency that rounds to 0.00 on the page is not called a correction. */
export { CORRECTED_FROM };

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

type EvidenceRow = { projectId: string; score: number | null; raw: number | null };
type EvidenceTrack = { id: string; name: string; rows: EvidenceRow[] };

/** Exported for tests. */
export function evidenceOf(method: string, params: Record<string, unknown>, tracks: EvidenceTrack[]): RankingEvidence {
  let placed = 0;
  let moved = 0;
  for (const { rows } of tracks) {
    const both = rows.filter((r) => r.score !== null && r.raw !== null);
    placed += rows.filter((r) => r.score !== null).length;
    // the places the page prints (competition places, ties sharing the first), so a project that
    // goes from joint 2nd to 3rd counts as moved; average ranks (2.5 to 3) would miss it
    const byScore = competitionPlaceOf(new Map(both.map((r) => [r.projectId, r.score!])));
    const byRaw = competitionPlaceOf(new Map(both.map((r) => [r.projectId, r.raw!])));
    for (const r of both) if (byScore.get(r.projectId) !== byRaw.get(r.projectId)) moved++;
  }
  const excluded = Array.isArray(params.excluded) ? params.excluded.length : 0;
  if (method === PAIRWISE_METHOD) {
    const counts = (params.counts ?? {}) as { picks?: number; fromScores?: number; judges?: number };
    const pull = (b: unknown): Pull => {
      const p = pullShare((b ?? null) as Bias);
      return p?.measured ? { share: p.share, pm: p.pm } : null;
    };
    // the fit's groups per track (union-find over the answers): a track in several groups has places
    // that compare only within a group, and the public page says so as the organizer's Results tab does
    const groups = Array.isArray(params.groups) ? (params.groups as { trackId: string; groups: number }[]) : [];
    const split = tracks.flatMap((t) => {
      const g = groups.find((x) => x.trackId === t.id)?.groups ?? 0;
      return g > 1 ? [{ track: t.name, groups: g }] : [];
    });
    return {
      kind: "pairwise",
      placed,
      moved,
      excluded,
      answers: counts.picks ?? 0,
      fromScores: counts.fromScores ?? 0,
      judges: counts.judges ?? 0,
      left: pull(params.left),
      fresh: pull(params.fresh),
      split: split.length ? split : null,
    };
  }
  const k = typeof params.k === "number" ? params.k : null;
  const stored = Array.isArray(params.judges) ? (params.judges as { leniency: number }[]) : null;
  // with no steady leniency (k is null) the engine takes nothing off anyone
  const sizes = stored?.map((j) => (k === null ? 0 : Math.abs(j.leniency))) ?? [];
  const signal = (params.signal ?? null) as SignalCheck | null;
  return {
    kind: "scores",
    placed,
    moved,
    excluded,
    k,
    judges: sizes.length
      ? { counted: sizes.length, corrected: sizes.filter((x) => x >= CORRECTED_FROM).length, largest: Math.max(...sizes), median: median(sizes) }
      : null,
    signal: signal ? { share: signal.share, trials: signal.trials } : null,
  };
}

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
      title: shownTitle(),
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
  const teamChanges = organizerChangesAfterCloseByProject(db, event);
  const judgesDecisions = (run.params as { judgesDecisions?: AppliedDecision[] }).judgesDecisions ?? [];
  const byTrack = new Map<string, { id: string; name: string; rows: typeof rows }>();
  for (const r of rows) {
    const t = byTrack.get(r.trackId) ?? { id: r.trackId, name: r.trackName, rows: [] };
    t.rows.push(r);
    byTrack.set(r.trackId, t);
  }
  const tie = run.method === METHOD ? ((run.params as { tieBreak?: StoredTieBreak }).tieBreak ?? null) : null;
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
    weightChanges: event.settings.weightChanges ?? [],
    trackMoves: (run.params as { trackMoves?: PublishedTrackMove[] }).trackMoves ?? [],
    unsettled: (run.params as { unsettled?: Unsettled }).unsettled ?? null,
    ...(tie ? { tieBreak: { criterion: tie.label } } : {}),
    // every change made after judging began, whatever the setting ended on: a switch back to joint places is a change too
    ...(event.settings.tieBreakChanges?.length ? { tieBreakChanges: event.settings.tieBreakChanges } : {}),
    evidence: evidenceOf(run.method, run.params as Record<string, unknown>, [...byTrack.values()]),
    tracks: [...byTrack.values()].map((t) => {
      // the published order: the engine's scores, then the tie-break among exact ties, then the judges' decision last
      const decided = judgesDecisions.find((d) => d.trackId === t.id && t.rows.some((r) => r.projectId === d.winnerId));
      if (decided) return decidedTrack(t, decided, tie, teamChanges);
      return { id: t.id, name: t.name, rows: placedRows(t.rows, tie, teamChanges) };
    }),
  };
}

type StoredRow = { projectId: string; title: string; teamName: string; n: number; score: number | null; se: number | null; raw: number | null; rankOverall: number | null };
type PublishedTrack = Extract<PublishedResults, { published: true }>["tracks"][number];
type PublishedRow = PublishedTrack["rows"][number];

/** One published row with its place, before any tie-break or decision. */
function publishedRow(r: StoredRow, place: number | null, teamChanges: Map<string, { at: string }>): PublishedRow {
  return {
    projectId: r.projectId,
    title: r.title,
    teamName: r.teamName,
    n: r.n,
    score: r.score,
    se: r.se,
    raw: r.raw,
    place,
    rankOverall: r.rankOverall,
    teamChangedAt: teamChanges.get(r.projectId)?.at ?? null,
  };
}

/**
 * Rows in score order, placed by score (ties sharing their average place), then by the event's tie-break when the run
 * stored one: exact score ties ordered by the stored figures; a tied group's average place then counts only the
 * projects still tied on the criterion too.
 */
function placedRows(rows: StoredRow[], tie: StoredTieBreak | null, teamChanges: Map<string, { at: string }>): PublishedRow[] {
  const places = averageRanks(new Map(rows.filter((r) => r.score !== null).map((r) => [r.projectId, r.score!])));
  if (!tie) return rows.map((r) => publishedRow(r, places.get(r.projectId) ?? null, teamChanges));
  const broken = breakTies(rows, new Map(tie.figures.map((f) => [f.id, f.figure])));
  const placed = competitionPlaces(broken);
  return broken.map((r, i) => {
    const p = placed[i]!;
    const alike = r.tie === null ? 1 : broken.filter((x) => x.tie !== null && x.score !== null && r.score !== null && Math.abs(x.score - r.score) <= 1e-9 && Math.abs(x.tie - r.tie!) <= 1e-9).length;
    return { ...publishedRow(r, r.tie === null ? (places.get(r.projectId) ?? null) : p.place! + (alike - 1) / 2, teamChanges), tie: r.tie, tieBroken: r.tieBroken };
  });
}

/**
 * A track whose close call the judges decided: their winner first, the rest below it in the order the scores and the
 * tie-break give them, placed 2nd on (ties among them share a place as everywhere). The score order stays on the record.
 */
function decidedTrack(t: { id: string; name: string; rows: StoredRow[] }, d: AppliedDecision, tie: StoredTieBreak | null, teamChanges: Map<string, { at: string }>): PublishedTrack {
  const ordered = withDecidedWinner(t.rows, d.winnerId);
  const rest = placedRows(ordered.slice(1), tie, teamChanges).map((r) => ({ ...r, place: r.place === null ? null : r.place + 1 }));
  const title = new Map(t.rows.map((r) => [r.projectId, r.title]));
  const winner: PublishedRow = { ...publishedRow(ordered[0]!, 1, teamChanges), ...(tie ? { tie: null, tieBroken: false } : {}), decided: true };
  return {
    id: t.id,
    name: t.name,
    rows: [winner, ...rest],
    decision: {
      winnerId: d.winnerId,
      reason: d.reason,
      at: d.at,
      scoreOrder: t.rows.map((r) => r.projectId),
      close: d.close.map((c) => ({ id: c.id, title: title.get(c.id) ?? c.id, p: c.p })),
    },
  };
}
