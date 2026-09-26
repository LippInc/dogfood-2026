import "server-only";
import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, events, judgeOverrides, normalizationRuns, normalizedScores, projects, scoreComments, scores, teams, tracks, userRoles, users } from "../db/schema";
import { ConflictError, NotFoundError } from "../errors";
import type { FlatFlag } from "../judging/flat";
import { averageRanks, normalize, permutationShare, type Obs, type SignalCheck } from "../judging/normalize";
import { guardRead, mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { isJudgeIn } from "./judges";
import { finishedReviews, judgeSet, rubricOf, weightedTotal, type ActiveOverride } from "./judging";
import { parse } from "./parse";

// Normalization as the organizer sees it, the decisions that stand between the
// scores and published results, and the audited actions that settle them: a
// judge override (with a required reason), a duplicate merge, accepting an
// under-reviewed project, and publishing, which stores the run it publishes.

export const METHOD = "leniency-shrunk-v1";
export const METHOD_LABEL = "Judge leniency, shrunk by n ÷ (n + k), with k estimated from this event's own scores";

type ProjectInfo = {
  id: string;
  title: string;
  trackId: string;
  trackName: string;
  teamId: string;
  teamName: string;
  duplicateOf: string | null;
  submittedAt: string | null;
  repoUrl: string | null;
};

function submittedProjects(db: DbOrTx, eventId: string): ProjectInfo[] {
  return db
    .select({
      id: projects.id,
      title: projects.title,
      trackId: projects.trackId,
      trackName: tracks.name,
      teamId: projects.teamId,
      teamName: teams.name,
      duplicateOf: projects.duplicateOf,
      submittedAt: projects.submittedAt,
      repoUrl: projects.repoUrl,
    })
    .from(projects)
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted")))
    .orderBy(asc(tracks.position), asc(projects.id))
    .all();
}

function judgeNames(db: DbOrTx, eventId: string): Map<string, string> {
  return new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .all()
      .map((u) => [u.id, u.name]),
  );
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export type Receipt = { judgeId: string; judge: string; y: number; leniency: number; adjusted: number; excluded: boolean };

export type ProjectRow = {
  id: string;
  title: string;
  trackId: string;
  trackName: string;
  teamName: string;
  duplicateOf: string | null;
  /** finished reviews, every judge / only the judges the engine keeps */
  nAll: number;
  n: number;
  rawAll: number | null;
  rawKept: number | null;
  score: number | null;
  /** one standard error of the score: √(σ̂² × its entry of the fitted system's inverse) */
  se: number | null;
  rankRaw: number | null;
  rankKept: number | null;
  rankNormalized: number | null;
  trackRankRaw: number | null;
  trackRank: number | null;
  underReviewed: boolean;
  receipts: Receipt[];
};

/** What one judge's reviews decide: the ranking with this judge's status flipped. */
export type Influence = {
  /** left out if counted now, counted again if left out now */
  change: "leave_out" | "reinstate";
  /** projects whose normalized rank moves by a place or more */
  moved: number;
  biggest: { id: string; title: string; from: number; to: number } | null;
  /** projects that would have no counted review left */
  unranked: number;
  /** tracks whose first place changes */
  leaders: { trackId: string; trackName: string; from: string[]; to: string[] }[];
};

export type JudgeStanding = {
  id: string;
  name: string;
  /** reviews the engine counts / every finished review by this judge */
  n: number;
  nAll: number;
  leniency: number;
  /** one standard error of the leniency; null when no leniency is fitted for this judge */
  se: number | null;
  /** n ÷ (n + k): how much of the judge's own tilt the engine keeps */
  shrink: number;
  /** the plain average of the judge's deviations from co-reviewers, unshrunk */
  tilt: number | null;
  flag: FlatFlag | null;
  override: ActiveOverride | null;
  excluded: boolean;
  /** when asked for: the single-judge influence check */
  influence: Influence | null;
};

export type Normalized = {
  variance: { W: number; beta2: number; sigma2: number; k: number | null };
  projects: ProjectRow[];
  judges: JudgeStanding[];
  ranked: number;
  moved: number;
  biggestMove: { id: string; title: string; from: number; to: number } | null;
  excluded: string[];
  /** the permutation signal check, when asked for (it costs 2,000 shuffles) */
  signal: SignalCheck | null;
};

/** One observation per judge and project; a judge who scored both copies of a merged duplicate counts once. */
function observations(db: DbOrTx, event: EventRow, info: ProjectInfo[]) {
  const criteria = rubricOf(db, event.id);
  const reviews = finishedReviews(db, event.id, criteria);
  const byId = new Map(info.map((p) => [p.id, p]));
  const canonical = (id: string) => byId.get(id)?.duplicateOf ?? id;
  const pairs = new Map<string, { judgeId: string; projectId: string; ys: number[] }>();
  const own = new Map<string, number[]>();
  for (const r of reviews) {
    if (!byId.has(r.projectId)) continue;
    const y = weightedTotal(criteria, r.values);
    own.set(r.projectId, [...(own.get(r.projectId) ?? []), y]);
    const projectId = canonical(r.projectId);
    const key = `${r.judgeId}\u0000${projectId}`;
    const entry = pairs.get(key) ?? { judgeId: r.judgeId, projectId, ys: [] };
    entry.ys.push(y);
    pairs.set(key, entry);
  }
  const obs: Obs[] = [...pairs.values()].map((e) => ({ judgeId: e.judgeId, projectId: e.projectId, y: mean(e.ys) }));
  return { obs, own, reviews };
}

function rankWithin<T extends { id: string }>(rows: T[], value: (r: T) => number | null, group: (r: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const v = value(r);
    if (v === null) continue;
    const g = groups.get(group(r)) ?? new Map<string, number>();
    g.set(r.id, v);
    groups.set(group(r), g);
  }
  for (const g of groups.values()) for (const [id, rank] of averageRanks(g)) out.set(id, rank);
  return out;
}

/** The normalized ranking of one judge set: overall and within each track. */
function rankingOf(keptObs: Obs[], canonicalRows: ProjectInfo[], errors = false) {
  const fit = normalize(keptObs, { errors });
  const score = new Map(canonicalRows.filter((p) => fit.scores.has(p.id)).map((p) => [p.id, fit.scores.get(p.id)!]));
  return {
    fit,
    score,
    overall: averageRanks(score),
    track: rankWithin(canonicalRows, (p) => score.get(p.id) ?? null, (p) => p.trackId),
  };
}

/** The ids holding first place in each track. */
function firstPlaces(canonicalRows: ProjectInfo[], track: Map<string, number>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of canonicalRows) {
    const r = track.get(p.id);
    if (r === undefined) continue;
    const best = out.get(p.trackId);
    const bestRank = best?.length ? track.get(best[0]!)! : Infinity;
    if (r < bestRank - 1e-9) out.set(p.trackId, [p.id]);
    else if (Math.abs(r - bestRank) <= 1e-9) best!.push(p.id);
  }
  return out;
}

/** The single-judge influence check: rank again with this judge's status flipped and say what moves. */
function influenceOf(judgeId: string, excluded: Set<string>, allObs: Obs[], canonicalRows: ProjectInfo[], base: ReturnType<typeof rankingOf>): Influence {
  const change = excluded.has(judgeId) ? "reinstate" : "leave_out";
  const flipped = new Set(excluded);
  if (change === "reinstate") flipped.delete(judgeId);
  else flipped.add(judgeId);
  const next = rankingOf(
    allObs.filter((o) => !flipped.has(o.judgeId)),
    canonicalRows,
  );
  const title = new Map(canonicalRows.map((p) => [p.id, p.title]));
  let moved = 0;
  let unranked = 0;
  let biggest: Influence["biggest"] = null;
  for (const [id, from] of base.overall) {
    const to = next.overall.get(id);
    if (to === undefined) {
      unranked++;
      continue;
    }
    const d = Math.abs(to - from);
    if (d >= 1) moved++;
    if (d >= 1 && (!biggest || d > Math.abs(biggest.to - biggest.from))) biggest = { id, title: title.get(id)!, from, to };
  }
  const before = firstPlaces(canonicalRows, base.track);
  const after = firstPlaces(canonicalRows, next.track);
  const trackName = new Map(canonicalRows.map((p) => [p.trackId, p.trackName]));
  const leaders: Influence["leaders"] = [];
  for (const trackId of new Set([...before.keys(), ...after.keys()])) {
    const a = [...(before.get(trackId) ?? [])].sort();
    const b = [...(after.get(trackId) ?? [])].sort();
    if (a.join("|") !== b.join("|")) {
      leaders.push({ trackId, trackName: trackName.get(trackId)!, from: a.map((id) => title.get(id)!), to: b.map((id) => title.get(id)!) });
    }
  }
  return { change, moved, biggest, unranked, leaders };
}

export function computeNormalization(
  db: DbOrTx,
  event: EventRow,
  opts: { exclude?: string[]; signal?: boolean; influence?: boolean } = {},
): Normalized {
  const info = submittedProjects(db, event.id);
  const { obs: allObs, own, reviews } = observations(db, event, info);
  const set = judgeSet(db, event.id, reviews);
  const excluded = new Set(opts.exclude ?? set.excluded);
  const keptObs = allObs.filter((o) => !excluded.has(o.judgeId));
  const canonicalRows = info.filter((p) => !p.duplicateOf);
  const base = rankingOf(keptObs, canonicalRows, true);
  const fit = base.fit;
  const names = judgeNames(db, event.id);

  const byProjectAll = new Map<string, Obs[]>();
  for (const o of allObs) byProjectAll.set(o.projectId, [...(byProjectAll.get(o.projectId) ?? []), o]);
  const byProjectKept = new Map<string, Obs[]>();
  for (const o of keptObs) byProjectKept.set(o.projectId, [...(byProjectKept.get(o.projectId) ?? []), o]);

  const rawAll = new Map(canonicalRows.filter((p) => byProjectAll.has(p.id)).map((p) => [p.id, mean(byProjectAll.get(p.id)!.map((o) => o.y))]));
  const rawKept = new Map(canonicalRows.filter((p) => byProjectKept.has(p.id)).map((p) => [p.id, mean(byProjectKept.get(p.id)!.map((o) => o.y))]));
  const score = base.score;
  const rankRaw = averageRanks(rawAll);
  const rankKept = averageRanks(rawKept);
  const rankNormalized = base.overall;
  const trackRank = base.track;
  const trackRankRaw = rankWithin(canonicalRows, (p) => rawAll.get(p.id) ?? null, (p) => p.trackId);

  const rows: ProjectRow[] = info.map((p) => {
    const merged = Boolean(p.duplicateOf);
    const all = merged ? [] : (byProjectAll.get(p.id) ?? []);
    const kept = merged ? [] : (byProjectKept.get(p.id) ?? []);
    const receipts: Receipt[] = all
      .map((o) => {
        const out = excluded.has(o.judgeId);
        const b = out ? 0 : (fit.leniency.get(o.judgeId) ?? 0);
        return { judgeId: o.judgeId, judge: names.get(o.judgeId) ?? o.judgeId, y: o.y, leniency: b, adjusted: o.y - b, excluded: out };
      })
      .sort((a, b) => Number(a.excluded) - Number(b.excluded) || b.y - a.y);
    const ownYs = own.get(p.id) ?? [];
    return {
      id: p.id,
      title: p.title,
      trackId: p.trackId,
      trackName: p.trackName,
      teamName: p.teamName,
      duplicateOf: p.duplicateOf,
      nAll: merged ? ownYs.length : all.length,
      n: kept.length,
      rawAll: merged ? (ownYs.length ? mean(ownYs) : null) : (rawAll.get(p.id) ?? null),
      rawKept: rawKept.get(p.id) ?? null,
      score: score.get(p.id) ?? null,
      se: score.has(p.id) ? (fit.se?.scores.get(p.id) ?? null) : null,
      rankRaw: rankRaw.get(p.id) ?? null,
      rankKept: rankKept.get(p.id) ?? null,
      rankNormalized: rankNormalized.get(p.id) ?? null,
      trackRankRaw: trackRankRaw.get(p.id) ?? null,
      trackRank: trackRank.get(p.id) ?? null,
      underReviewed: !merged && kept.length < 2,
      receipts,
    };
  });
  rows.sort(
    (a, b) =>
      Number(Boolean(a.duplicateOf)) - Number(Boolean(b.duplicateOf)) ||
      (a.rankNormalized ?? 1e9) - (b.rankNormalized ?? 1e9) ||
      a.id.localeCompare(b.id),
  );

  // The plain tilt: a judge's average deviation from the other reviewers of the same projects.
  const tilts = new Map<string, number[]>();
  for (const list of byProjectKept.values()) {
    if (list.length < 2) continue;
    const total = list.reduce((s, o) => s + o.y, 0);
    for (const o of list) tilts.set(o.judgeId, [...(tilts.get(o.judgeId) ?? []), o.y - (total - o.y) / (list.length - 1)]);
  }
  const counts = new Map<string, number>();
  for (const o of keptObs) counts.set(o.judgeId, (counts.get(o.judgeId) ?? 0) + 1);
  const countsAll = new Map<string, number>();
  for (const o of allObs) countsAll.set(o.judgeId, (countsAll.get(o.judgeId) ?? 0) + 1);
  const judgeIds = [...new Set([...names.keys(), ...allObs.map((o) => o.judgeId)])];
  const judges: JudgeStanding[] = judgeIds
    .map((id) => {
      const n = counts.get(id) ?? 0;
      const t = tilts.get(id);
      const fitted = fit.kUsed !== null && !excluded.has(id) && n > 0;
      return {
        id,
        name: names.get(id) ?? id,
        n,
        nAll: countsAll.get(id) ?? 0,
        leniency: fit.leniency.get(id) ?? 0,
        se: fitted ? (fit.se?.leniency.get(id) ?? null) : null,
        shrink: fit.kUsed === null || excluded.has(id) ? 0 : n / (n + fit.kUsed),
        tilt: t && t.length ? mean(t) : null,
        flag: set.flags.find((f) => f.judgeId === id) ?? null,
        override: [...set.overrides].reverse().find((o) => o.judgeId === id) ?? null,
        excluded: excluded.has(id),
        influence: opts.influence && (countsAll.get(id) ?? 0) > 0 ? influenceOf(id, excluded, allObs, canonicalRows, base) : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  let moved = 0;
  let biggest: Normalized["biggestMove"] = null;
  for (const r of rows) {
    if (r.rankRaw === null || r.rankNormalized === null) continue;
    const d = Math.abs(r.rankNormalized - r.rankRaw);
    if (d >= 1) moved++;
    if (d >= 1 && (!biggest || d > Math.abs(biggest.to - biggest.from))) biggest = { id: r.id, title: r.title, from: r.rankRaw, to: r.rankNormalized };
  }

  return {
    variance: { W: fit.W, beta2: fit.beta2, sigma2: fit.sigma2, k: fit.kUsed },
    projects: rows,
    judges,
    ranked: score.size,
    moved,
    biggestMove: biggest,
    excluded: [...excluded].sort(),
    signal: opts.signal && keptObs.length > 1 ? permutationShare(keptObs) : null,
  };
}

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
      copies: { id: string; title: string; submittedAt: string | null; repoUrl: string | null; rankRaw: number | null; n: number }[];
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
    };

export function decisions(db: DbOrTx, event: EventRow, now = computeNormalization(db, event)): Decision[] {
  const out: Decision[] = [];
  const reviews = finishedReviews(db, event.id);
  const set = judgeSet(db, event.id, reviews);
  for (const flag of set.flags) {
    const override = [...set.overrides].reverse().find((o) => o.judgeId === flag.judgeId) ?? null;
    const without = new Set([...now.excluded, flag.judgeId]);
    const withJudge = new Set(now.excluded.filter((id) => id !== flag.judgeId));
    const a = computeNormalization(db, event, { exclude: [...withJudge] });
    const b = computeNormalization(db, event, { exclude: [...without] });
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
    const k = `${p.teamId}\u0000${normTitle(p.title)}`;
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
        return { id: c.id, title: c.title, submittedAt: c.submittedAt, repoUrl: c.repoUrl, rankRaw: row?.rankRaw ?? null, n: row?.nAll ?? 0 };
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
  return { event, method: METHOD_LABEL, normalization: now, decisions: decisions(db, event, now), notes: privateNotes(db, event.id, now.projects) };
}

// ---------------------------------------------------------------------------
// Audited actions
// ---------------------------------------------------------------------------

function organizerMutation<T>(actor: Actor | null, eventIdOrSlug: string, run: (tx: DbOrTx, event: EventRow) => { result: T; audit: Parameters<typeof mutate<T>>[0]["run"] extends (tx: never) => { audit: infer A } ? A : never }) {
  let event: EventRow;
  return mutate<T>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => run(tx, event),
  });
}

function notPublished(event: EventRow) {
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
    tx.update(projects).set({ duplicateOf: keepId }).where(eq(projects.id, duplicateId)).run();
    return {
      result: { keepId, duplicateId },
      audit: { action: "project.merge", eventId: event.id, targetType: "project", targetId: duplicateId, after: { into: keepId } },
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
    tx.update(projects).set({ duplicateOf: null }).where(eq(projects.id, duplicateId)).run();
    return {
      result: { duplicateId },
      audit: { action: "project.unmerge", eventId: event.id, targetType: "project", targetId: duplicateId, before: { into: row.duplicateOf } },
    };
  });
}

export const PairInput = z.object({ ids: z.array(z.string().min(1)).min(2), reason: Reason });

/** The organizer rules that same-titled projects of one team are different projects. */
export function dismissDuplicate(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { ids, reason } = parse(PairInput, body);
    const sorted = [...new Set(ids)].sort();
    const pairs = sorted.flatMap((a, i) => sorted.slice(i + 1).map((b) => pairKey(a, b)));
    const notDuplicates = [...new Set([...(event.settings.notDuplicates ?? []), ...pairs])].sort();
    tx.update(events).set({ settings: { ...event.settings, notDuplicates } }).where(eq(events.id, event.id)).run();
    return {
      result: { ids: sorted },
      audit: { action: "project.not_duplicate", eventId: event.id, targetType: "project", targetId: sorted[0]!, after: { ids: sorted, reason } },
    };
  });
}

export const AcceptInput = z.object({ projectId: z.string().min(1), reason: Reason });

/** Publish an under-reviewed project as it is; the results mark it. */
export function acceptUnderReviewed(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const { projectId, reason } = parse(AcceptInput, body);
    const accepted = [...new Set([...(event.settings.acceptedUnderReviewed ?? []), projectId])].sort();
    tx.update(events).set({ settings: { ...event.settings, acceptedUnderReviewed: accepted } }).where(eq(events.id, event.id)).run();
    return {
      result: { projectId },
      audit: { action: "project.accept_under_reviewed", eventId: event.id, targetType: "project", targetId: projectId, after: { reason } },
    };
  });
}

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
      },
      computedAt: at,
      computedBy: actor.userId,
    })
    .run();
  for (const p of n.projects) {
    if (p.duplicateOf) continue;
    tx.insert(normalizedScores)
      .values({ runId: id, projectId: p.id, n: p.n, rawMean: p.rawAll, normalizedMean: p.score, rankRaw: p.rankRaw, rankNormalized: p.rankNormalized })
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
    const n = computeNormalization(tx, event, { signal: true });
    const open = decisions(tx, event, n).filter((d) => !d.resolved);
    if (open.length) {
      throw new ConflictError("decisions_open", `${open.length} ${open.length === 1 ? "decision is" : "decisions are"} still open. Settle ${open.length === 1 ? "it" : "them"} before publishing.`);
    }
    const at = new Date().toISOString();
    const runId = storeRun(tx, event, actor!, n, at);
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
        after: { k: n.variance.k, beta2: n.variance.beta2, sigma2: n.variance.sigma2, ranked: n.ranked, excluded: n.excluded },
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
      k: number | null;
      tracks: {
        id: string;
        name: string;
        rows: { projectId: string; title: string; teamName: string; n: number; score: number | null; raw: number | null; place: number | null; rankOverall: number | null }[];
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
  return {
    published: true,
    publishedAt: event.resultsPublishedAt,
    runId,
    k: (run.params as { k?: number | null }).k ?? null,
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
          raw: r.raw,
          place: places.get(r.projectId) ?? null,
          rankOverall: r.rankOverall,
        })),
      };
    }),
  };
}
