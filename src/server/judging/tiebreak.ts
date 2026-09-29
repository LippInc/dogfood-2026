import "server-only";
// The tie-break stage of a track's published order (JUDGING.md, "Breaking exact ties"): the engine's
// scores decide the order; among projects whose scores are exactly tied (within 1e-9, the rule the
// places use), the organizer's chosen rubric criterion decides, higher first. Projects tied on that
// criterion too stay joint. Pure: the caller hands in each project's figure on the criterion.

/** Scores (or criterion figures) this close are the same number: the places' own rule (src/lib/places.ts). */
export const TIE_EPSILON = 1e-9;

const same = (a: number, b: number) => Math.abs(a - b) <= TIE_EPSILON;

/**
 * One review's figure on the criterion, the judge who gave it and the project it counts for (a merged copy's
 * review counts for the copy kept, as the engine counts it).
 */
export type CriterionObs = { judgeId: string; projectId: string; value: number };

/**
 * Each project's plain mean on the criterion over its counted reviews: one figure per judge and project (a judge who
 * scored both copies of a merged duplicate counts once, at the mean of the two), then the mean over the judges. The
 * caller passes only the reviews the engine counts (finished, not recused or conflicted, judges not left out).
 */
export function criterionMeans(obs: readonly CriterionObs[]): Map<string, number> {
  const pairs = new Map<string, { projectId: string; sum: number; n: number }>();
  for (const o of obs) {
    const key = `${o.judgeId}\u0000${o.projectId}`;
    const p = pairs.get(key) ?? { projectId: o.projectId, sum: 0, n: 0 };
    p.sum += o.value;
    p.n += 1;
    pairs.set(key, p);
  }
  const byProject = new Map<string, number[]>();
  for (const p of pairs.values()) byProject.set(p.projectId, [...(byProject.get(p.projectId) ?? []), p.sum / p.n]);
  return new Map([...byProject].map(([id, xs]) => [id, xs.reduce((s, x) => s + x, 0) / xs.length]));
}

export type TieBroken<T> = T & {
  /** the project's figure on the tie-break criterion; null when its score is tied with no other project's */
  tie: number | null;
  /** its exact score tie was split, at least in part, by the criterion */
  tieBroken: boolean;
};

/**
 * A track's rows, best first by score, with every exact score tie ordered by the criterion (higher first; still tied
 * rows keep their order). Rows with no score keep their place at the end. A row outside any tie gets tie: null, so
 * places.ts places it by its score alone; a tied row gets its criterion figure. The rows' own order within a group
 * that the criterion does not split is kept, so a group left joint reads as before.
 */
export function breakTies<T extends { projectId: string; score: number | null }>(rows: readonly T[], means: ReadonlyMap<string, number>): TieBroken<T>[] {
  const out: TieBroken<T>[] = [];
  let i = 0;
  while (i < rows.length) {
    const head = rows[i]!;
    if (head.score === null) {
      out.push({ ...head, tie: null, tieBroken: false });
      i++;
      continue;
    }
    let j = i + 1;
    while (j < rows.length && rows[j]!.score !== null && same(rows[j]!.score!, head.score)) j++;
    const group = rows.slice(i, j);
    if (group.length === 1) {
      out.push({ ...head, tie: null, tieBroken: false });
    } else {
      const figure = (r: T) => means.get(r.projectId) ?? Number.NEGATIVE_INFINITY;
      const sorted = group.map((r, k) => ({ r, k })).sort((a, b) => (same(figure(a.r), figure(b.r)) ? a.k - b.k : figure(b.r) - figure(a.r)));
      for (const { r } of sorted) {
        const mine = figure(r);
        const alike = group.filter((x) => same(figure(x), mine)).length;
        out.push({ ...r, tie: means.get(r.projectId) ?? null, tieBroken: alike < group.length });
      }
    }
    i = j;
  }
  return out;
}

/** The exact score ties the criterion split, per track: what the published run and its audit row record. */
export type TieBreakGroup = { trackId: string; score: number; projects: { id: string; figure: number | null }[]; broken: boolean };

export function tieGroups<T extends { projectId: string; score: number | null }>(trackId: string, rows: readonly TieBroken<T>[]): TieBreakGroup[] {
  const groups: TieBreakGroup[] = [];
  for (const r of rows) {
    if (r.tie === null && !r.tieBroken) continue;
    const last = groups.at(-1);
    if (last && r.score !== null && same(last.score, r.score)) {
      last.projects.push({ id: r.projectId, figure: r.tie });
      last.broken ||= r.tieBroken;
    } else if (r.score !== null) {
      groups.push({ trackId, score: r.score, projects: [{ id: r.projectId, figure: r.tie }], broken: r.tieBroken });
    }
  }
  return groups;
}
