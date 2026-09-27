import "server-only";
import type { Obs } from "./normalize";
import { seededRng } from "./random";

// The organizers' own yardstick for a normalization (their "Normalization Proof" line:
// "σ of per-judge means"): how far apart the judges' averages are, raw and once each
// judge's estimated leniency is taken out. A spread of judge averages mixes two things,
// a judge's real tilt and the luck of which projects the judge happened to get, so the
// yardstick comes with a baseline: the spread judges with no tilt at all would show on
// the same judge-project pairs, from the event's own project spread and review noise.
// The engine is not changed by any of this; it is a disclosure next to its result.

export type Yardstick = {
  /** judges counted: those with at least one counted review */
  judges: number;
  /** sample standard deviation of the judges' average totals */
  raw: number;
  /** the same, with each judge's estimated leniency taken out of their totals */
  after: number;
  /** the largest leniency taken out of any judge, in size */
  largestLeniency: number;
  /** fair judges (no tilt) on the same pairs: the spread's median, 5th and 95th percentiles, and how often it reaches the raw one */
  fair: { median: number; low: number; high: number; atOrAbove: number; runs: number };
};

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sampleSd = (xs: readonly number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

function spreadOfJudgeMeans(obs: readonly Obs[], value: (o: Obs) => number): number {
  const byJudge = new Map<string, number[]>();
  for (const o of obs) byJudge.set(o.judgeId, [...(byJudge.get(o.judgeId) ?? []), value(o)]);
  return sampleSd([...byJudge.values()].map(mean));
}

/**
 * The yardstick for one event's counted reviews. `sigma2` is the engine's review-noise
 * variance. The baseline draws project levels with the between-project variance the
 * reviews show (a moment estimate: the spread of project means less what noise alone
 * gives them, never below 0) and review noise with `sigma2`, on exactly these pairs, and
 * no leniency; `runs` draws from a fixed seed, so the same reviews give the same numbers.
 * Null with fewer than two judges.
 */
export function judgeSpread(obs: readonly Obs[], leniency: ReadonlyMap<string, number>, sigma2: number, runs = 400, seed = 20260927): Yardstick | null {
  const judges = new Set(obs.map((o) => o.judgeId));
  if (judges.size < 2) return null;
  const raw = spreadOfJudgeMeans(obs, (o) => o.y);
  const after = spreadOfJudgeMeans(obs, (o) => o.y - (leniency.get(o.judgeId) ?? 0));
  const largestLeniency = Math.max(0, ...[...judges].map((j) => Math.abs(leniency.get(j) ?? 0)));

  const byProject = new Map<string, number[]>();
  for (const o of obs) byProject.set(o.projectId, [...(byProject.get(o.projectId) ?? []), o.y]);
  const projectIds = [...byProject.keys()];
  const within = sigma2;
  const between = projectIds.length > 1 ? sampleSd(projectIds.map((p) => mean(byProject.get(p)!))) ** 2 : 0;
  const tau2 = Math.max(0, between - mean(projectIds.map((p) => within / byProject.get(p)!.length)));

  const random = seededRng(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const spreads: number[] = [];
  for (let r = 0; r < runs; r++) {
    const level = new Map(projectIds.map((p) => [p, normal() * Math.sqrt(tau2)]));
    const drawn = obs.map((o) => ({ ...o, y: level.get(o.projectId)! + normal() * Math.sqrt(within) }));
    spreads.push(spreadOfJudgeMeans(drawn, (o) => o.y));
  }
  spreads.sort((a, b) => a - b);
  const at = (q: number) => spreads[Math.round(q * (spreads.length - 1))]!;
  return {
    judges: judges.size,
    raw,
    after,
    largestLeniency,
    fair: { median: at(0.5), low: at(0.05), high: at(0.95), atOrAbove: spreads.filter((s) => s >= raw).length / runs, runs },
  };
}
