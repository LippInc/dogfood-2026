import "server-only";

// The normalization engine (BUILD-PLAN decision 11, re-decided 2026-09-24).
//
// Each finished review's organizer-weighted total y is modelled as
//     y = project level + judge leniency + noise.
// Project levels are not shrunk: a project with fewer reviews is never pulled
// toward the middle for it. Each judge's leniency is shrunk by n / (n + k), with
// k = σ̂² / β̂² estimated from this event's own scores:
//   β̂² (how much judges really differ in leniency) from the covariance of a judge's
//       deviations from co-reviewers across their projects, corrected for the
//       co-reviewers the two projects share;
//   σ̂² = max(0.05, W − β̂²), W the pooled within-project variance.
// If β̂² ≤ 0 the data show no leniency and none is corrected. Flat judges are left
// out before any of this (flat.ts). The fit solves the normal equations directly
// (one Cholesky); fitByAlternation() reaches the same answer by alternating updates
// and exists so the tests can hold one against the other.

export type Obs = { judgeId: string; projectId: string; y: number };

export type Variance = {
  /** between-judge leniency variance */
  beta2: number;
  /** pooled within-project variance */
  W: number;
  /** review noise variance, max(0.05, W − β̂²) */
  sigma2: number;
  /** σ̂² / β̂², or null when β̂² ≤ 0 (no leniency correction) */
  k: number | null;
};

export type Fit = {
  /** project id → normalized score (its level on the reviews' own scale) */
  scores: Map<string, number>;
  /** judge id → estimated leniency (+ is generous) */
  leniency: Map<string, number>;
};

const SIGMA2_FLOOR = 0.05;

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

export function estimateVariance(obs: readonly Obs[]): Variance {
  const byProject = groupBy(obs, (o) => o.projectId);
  const size = new Map([...byProject].map(([p, l]) => [p, l.length]));
  const reviewers = new Map([...byProject].map(([p, l]) => [p, new Set(l.map((o) => o.judgeId))]));

  // d_r: a review minus the mean of the other reviews of the same project.
  const deviations: { judgeId: string; projectId: string; d: number }[] = [];
  for (const [projectId, list] of byProject) {
    if (list.length < 2) continue;
    const total = list.reduce((s, o) => s + o.y, 0);
    for (const o of list) deviations.push({ judgeId: o.judgeId, projectId, d: o.y - (total - o.y) / (list.length - 1) });
  }

  let num = 0;
  let den = 0;
  for (const list of groupBy(deviations, (x) => x.judgeId).values()) {
    const n = list.length;
    if (n < 2) continue;
    let cn = 0;
    let cd = 0;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const r = list[a]!;
        const s = list[b]!;
        const judge = r.judgeId;
        let shared = 0;
        for (const j of reviewers.get(r.projectId)!) if (j !== judge && reviewers.get(s.projectId)!.has(j)) shared++;
        cn += r.d * s.d;
        cd += 1 + shared / ((size.get(r.projectId)! - 1) * (size.get(s.projectId)! - 1));
      }
    }
    num += (n - 1) * (cn / cd);
    den += n - 1;
  }
  const beta2 = den ? Math.max(0, num / den) : 0;

  let wn = 0;
  let wd = 0;
  for (const list of byProject.values()) {
    const mean = list.reduce((s, o) => s + o.y, 0) / list.length;
    for (const o of list) wn += (o.y - mean) ** 2;
    wd += list.length - 1;
  }
  const W = wd ? wn / wd : 0;
  const sigma2 = Math.max(SIGMA2_FLOOR, W - beta2);
  return { beta2, W, sigma2, k: beta2 > 0 ? sigma2 / beta2 : null };
}

/** Solve A x = b for a symmetric positive-definite A (dense Cholesky). */
export function choleskySolve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (sum <= 0) throw new Error("normal equations are not positive definite");
        L[i]![i] = Math.sqrt(sum);
      } else {
        L[i]![j] = sum / L[j]![j]!;
      }
    }
  }
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= L[i]![k]! * z[k]!;
    z[i] = sum / L[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = z[i]!;
    for (let k = i + 1; k < n; k++) sum -= L[k]![i]! * x[k]!;
    x[i] = sum / L[i]![i]!;
  }
  return x;
}

const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * Minimise Σ (y − θ_project − b_judge)² + k Σ b², projects unpenalised. With k null
 * no leniency is fitted and each project's level is its plain mean.
 */
export function fitLeniency(obs: readonly Obs[], k: number | null): Fit {
  const projects = sortedIds(obs.map((o) => o.projectId));
  const judges = sortedIds(obs.map((o) => o.judgeId));
  if (k === null) {
    const scores = new Map<string, number>();
    for (const [p, list] of groupBy(obs, (o) => o.projectId)) scores.set(p, list.reduce((s, o) => s + o.y, 0) / list.length);
    return { scores, leniency: new Map(judges.map((j) => [j, 0])) };
  }
  const P = projects.length;
  const n = P + judges.length;
  const ip = new Map(projects.map((p, i) => [p, i]));
  const ij = new Map(judges.map((j, i) => [j, P + i]));
  const A = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const rhs = new Array<number>(n).fill(0);
  for (const o of obs) {
    const a = ip.get(o.projectId)!;
    const b = ij.get(o.judgeId)!;
    A[a]![a]! += 1;
    A[b]![b]! += 1;
    A[a]![b]! += 1;
    A[b]![a]! += 1;
    rhs[a]! += o.y;
    rhs[b]! += o.y;
  }
  for (let i = P; i < n; i++) A[i]![i]! += k;
  const x = choleskySolve(A, rhs);
  return {
    scores: new Map(projects.map((p, i) => [p, x[i]!])),
    leniency: new Map(judges.map((j, i) => [j, x[P + i]!])),
  };
}

/** The same fit by alternating updates, to the given tolerance. For the tests. */
export function fitByAlternation(obs: readonly Obs[], k: number, tol = 1e-13, maxSweeps = 200_000): Fit {
  const byProject = groupBy(obs, (o) => o.projectId);
  const byJudge = groupBy(obs, (o) => o.judgeId);
  const theta = new Map([...byProject.keys()].map((p) => [p, 0]));
  const lean = new Map([...byJudge.keys()].map((j) => [j, 0]));
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let change = 0;
    for (const [p, list] of byProject) {
      const next = list.reduce((s, o) => s + o.y - lean.get(o.judgeId)!, 0) / list.length;
      change = Math.max(change, Math.abs(next - theta.get(p)!));
      theta.set(p, next);
    }
    for (const [j, list] of byJudge) {
      const next = list.reduce((s, o) => s + o.y - theta.get(o.projectId)!, 0) / (list.length + k);
      change = Math.max(change, Math.abs(next - lean.get(j)!));
      lean.set(j, next);
    }
    if (change < tol) break;
  }
  return { scores: theta, leniency: lean };
}

/** Average ranks, 1 = highest; equal values (within 1e-9) share the mean of their places. */
export function averageRanks(values: ReadonlyMap<string, number>): Map<string, number> {
  const sorted = [...values].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const ranks = new Map<string, number>();
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && Math.abs(sorted[j + 1]![1] - sorted[i]![1]) <= 1e-9) j++;
    const rank = (i + 1 + (j + 1)) / 2;
    for (let t = i; t <= j; t++) ranks.set(sorted[t]![0], rank);
    i = j + 1;
  }
  return ranks;
}

export type Normalization = Variance & Fit & { kUsed: number | null };

/** Estimate k from the data (or use a fixed one, for the comparison row) and fit. */
export function normalize(obs: readonly Obs[], opts: { fixedK?: number } = {}): Normalization {
  const variance = estimateVariance(obs);
  const kUsed = opts.fixedK ?? variance.k;
  return { ...variance, kUsed, ...fitLeniency(obs, kUsed) };
}

/** Sample variance of the project means. */
function varianceOfMeans(obs: readonly Obs[], ys: readonly number[]): number {
  const sums = new Map<string, [number, number]>();
  obs.forEach((o, i) => {
    const s = sums.get(o.projectId) ?? [0, 0];
    s[0] += ys[i]!;
    s[1] += 1;
    sums.set(o.projectId, s);
  });
  const means = [...sums.values()].map(([s, n]) => s / n);
  if (means.length < 2) return 0;
  const m = means.reduce((a, b) => a + b, 0) / means.length;
  return means.reduce((a, b) => a + (b - m) ** 2, 0) / (means.length - 1);
}

export type SignalCheck = { share: number; trials: number; seed: number; observed: number };

/**
 * The signal check: do the projects differ by more than chance? Shuffle the review
 * totals across reviews (same judges, same projects) and count how often the
 * shuffled project means spread at least as much as the real ones. A share near 0
 * means real differences; near 0.5 or above, the scores cannot tell the projects
 * apart better than a shuffle.
 */
export function permutationShare(obs: readonly Obs[], trials = 2000, seed = 20260924): SignalCheck {
  const ys = obs.map((o) => o.y);
  const observed = varianceOfMeans(obs, ys);
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let hits = 0;
  const s = [...ys];
  for (let k = 0; k < trials; k++) {
    for (let i = s.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [s[i], s[j]] = [s[j]!, s[i]!];
    }
    if (varianceOfMeans(obs, s) >= observed - 1e-12) hits++;
  }
  return { share: hits / trials, trials, seed, observed };
}
