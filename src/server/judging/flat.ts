import "server-only";
// The flat-judge rule (JUDGING.md): a judge with at least three finished
// reviews whose score vector is identical on every project they scored carries no
// ranking information, so the engine leaves them out as a whole judge, with a
// visible flag that states the reason. The organizer can override the rule either
// way with a reason; the rule is a reversible flag, never a silent deletion.

export const FLAT_MIN_REVIEWS = 3;

export type FinishedReview = { judgeId: string; projectId: string; values: number[] };

export type FlatFlag = { judgeId: string; reviews: number; vector: number[] };

export function flatJudges(reviews: readonly FinishedReview[], minReviews = FLAT_MIN_REVIEWS): FlatFlag[] {
  const byJudge = new Map<string, number[][]>();
  for (const r of reviews) {
    const list = byJudge.get(r.judgeId) ?? [];
    list.push(r.values);
    byJudge.set(r.judgeId, list);
  }
  const flags: FlatFlag[] = [];
  for (const [judgeId, vectors] of [...byJudge].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (vectors.length < minReviews) continue;
    const first = vectors[0]!.join(",");
    if (vectors.every((v) => v.join(",") === first)) flags.push({ judgeId, reviews: vectors.length, vector: vectors[0]! });
  }
  return flags;
}

export type Override = { judgeId: string; mode: "include" | "exclude" };

/** The judges a run leaves out: flagged ones not reinstated, plus any excluded by hand. */
export function excludedJudges(flags: readonly FlatFlag[], overrides: readonly Override[]): string[] {
  const include = new Set(overrides.filter((o) => o.mode === "include").map((o) => o.judgeId));
  const out = new Set(flags.map((f) => f.judgeId).filter((id) => !include.has(id)));
  for (const o of overrides) if (o.mode === "exclude") out.add(o.judgeId);
  return [...out].sort();
}
