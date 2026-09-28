import "server-only";
import type { DbOrTx } from "../db/client";
import type { FlatFlag } from "../judging/flat";
import { averageRanks, normalize, permutationShare, type Obs, type SignalCheck } from "../judging/normalize";
import { judgeSpread, type Yardstick } from "../judging/yardstick";
import type { EventRow } from "./events";
import { finishedReviews, formerJudges, judgeSet, rubricOf, weightedTotal, type ActiveOverride, judgeNames, submittedProjects, type ProjectInfo } from "./judging";

// Normalization as the organizer sees it: the score engine's run over an event's finished
// reviews, with each project's receipt, the judge ledger and the ranking. The decisions that
// stand between it and published results are in decisions.ts; the results view and
// publishing, which stores the run it publishes, are in results.ts.

export const METHOD = "leniency-shrunk-v1";
export const METHOD_LABEL = "Judge leniency, shrunk by n ÷ (n + k), with k estimated from this event's own scores";

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

export type Receipt = {
  judgeId: string;
  judge: string;
  y: number;
  leniency: number;
  adjusted: number;
  excluded: boolean;
  /** an organizer removed this judge from the event: the review stays on record, out of the ranking */
  removed: boolean;
};

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
  /** an organizer removed this judge from the event (their exclusion carries the reason) */
  removed: boolean;
  /** when asked for: the single-judge influence check */
  influence: Influence | null;
};

export type Normalized = {
  /** measured: false while no project has two counted reviews (β̂² and σ̂² then have no data) */
  variance: { W: number; beta2: number; sigma2: number; k: number | null; measured: boolean };
  projects: ProjectRow[];
  judges: JudgeStanding[];
  ranked: number;
  moved: number;
  biggestMove: { id: string; title: string; from: number; to: number } | null;
  excluded: string[];
  /** the permutation signal check, when asked for (it costs 2,000 shuffles) */
  signal: SignalCheck | null;
  /** the organizers' yardstick, the spread of the counted judges' averages, raw and after, with the fair-judge baseline; null until noise is measured */
  yardstick: Yardstick | null;
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
  const former = formerJudges(db, event.id);
  const names = new Map([...judgeNames(db, event.id), ...former]);

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
        return { judgeId: o.judgeId, judge: names.get(o.judgeId) ?? o.judgeId, y: o.y, leniency: b, adjusted: o.y - b, excluded: out, removed: former.has(o.judgeId) };
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
        removed: former.has(id),
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
    variance: { W: fit.W, beta2: fit.beta2, sigma2: fit.sigma2, k: fit.kUsed, measured: fit.measured },
    projects: rows,
    judges,
    ranked: score.size,
    moved,
    biggestMove: biggest,
    excluded: [...excluded].sort(),
    signal: opts.signal && keptObs.length > 1 ? permutationShare(keptObs) : null,
    yardstick: fit.measured ? judgeSpread(keptObs, fit.leniency, fit.sigma2) : null,
  };
}

