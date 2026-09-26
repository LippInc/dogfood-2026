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
// out before any of this (flat.ts). The fit solves the normal equations directly.
// Project levels are not penalised, so they are eliminated exactly first (the Schur
// complement): what is left is one system with a row per judge, solved by one
// Cholesky, and each project's level follows as the mean of its reviews minus its
// judges' leniencies. The cost grows with the judges cubed, not with the projects,
// so an event of 1,000 projects is as quick as the sample event. fitDense() solves
// the full system instead and fitByAlternation() reaches the same answer by
// alternating updates; both exist so the tests can hold the three against each other.
//
// Each estimate's ± is one standard error from the same system (Henderson's
// mixed-model equations): the error variance of a project's score, and of a judge's
// leniency against the judge's true one, is σ̂² times that entry of the diagonal
// of the inverse of the matrix the fit solves. It counts both the review noise and
// how well the reviewers' leniencies are known.

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
  /** when asked for: the diagonal of the fitted system's inverse; times σ̂², each estimate's error variance */
  factors?: { scores: Map<string, number>; leniency: Map<string, number> };
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

/** The Cholesky factor L of a symmetric positive-definite A (A = L Lᵀ). */
function choleskyFactor(A: number[][]): number[][] {
  const n = A.length;
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
  return L;
}

function solveFactored(L: number[][], b: number[]): number[] {
  const n = b.length;
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

/** Solve A x = b for a symmetric positive-definite A (dense Cholesky). */
export function choleskySolve(A: number[][], b: number[]): number[] {
  return solveFactored(choleskyFactor(A), b);
}

/** The diagonal of A⁻¹ from A's Cholesky factor: (A⁻¹)ᵢᵢ = ‖L⁻¹ eᵢ‖². */
export function inverseDiagonal(L: number[][]): number[] {
  const n = L.length;
  const out = new Array<number>(n).fill(0);
  const z = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let squares = 0;
    for (let r = i; r < n; r++) {
      let sum = r === i ? 1 : 0;
      for (let c = i; c < r; c++) sum -= L[r]![c]! * z[c]!;
      z[r] = sum / L[r]![r]!;
      squares += z[r]! * z[r]!;
    }
    out[i] = squares;
  }
  return out;
}

/** The inverse's diagonal of a symmetric positive-definite A, for the tests. */
export function choleskyInverseDiagonal(A: number[][]): number[] {
  return inverseDiagonal(choleskyFactor(A));
}

const sortedIds = (ids: Iterable<string>) => [...new Set(ids)].sort();

/** Invert a symmetric positive-definite matrix from its Cholesky factor (column by column). */
function inverseFromFactor(L: number[][]): number[][] {
  const n = L.length;
  return Array.from({ length: n }, (_, i) => solveFactored(L, Array.from({ length: n }, (__, t) => (t === i ? 1 : 0))));
}

/**
 * Minimise Σ (y − θ_project − b_judge)² + k Σ b², projects unpenalised. With k null
 * no leniency is fitted and each project's level is its plain mean. With errors,
 * also the inverse's diagonal (1 ÷ n for a plain mean; 0 for a leniency not fitted).
 *
 * With D the review counts and N the project × judge counts, the normal equations
 * are [Dp N; Nᵀ Dj + kI] [θ; b] = [rp; rj]. Eliminating θ = Dp⁻¹ (rp − N b) leaves
 * S b = rj − Nᵀ Dp⁻¹ rp with S = Dj + kI − Nᵀ Dp⁻¹ N (a judge × judge matrix, positive
 * definite for k > 0). For the errors, the inverse's diagonal is (S⁻¹)ⱼⱼ for a judge
 * and 1 ÷ nₚ + nₚᵀ S⁻¹ nₚ ÷ nₚ² for a project, with nₚ that project's judge counts.
 */
export function fitLeniency(obs: readonly Obs[], k: number | null, errors = false): Fit {
  if (k === null) return fitDense(obs, null, errors);
  const projects = sortedIds(obs.map((o) => o.projectId));
  const judges = sortedIds(obs.map((o) => o.judgeId));
  const J = judges.length;
  const ij = new Map(judges.map((j, i) => [j, i]));
  // per project: its review count, its total and its judges' counts
  const rows = new Map(projects.map((p) => [p, { n: 0, sum: 0, judges: new Map<number, number>() }]));
  const nJudge = new Array<number>(J).fill(0);
  const rJudge = new Array<number>(J).fill(0);
  for (const o of obs) {
    const row = rows.get(o.projectId)!;
    const j = ij.get(o.judgeId)!;
    row.n += 1;
    row.sum += o.y;
    row.judges.set(j, (row.judges.get(j) ?? 0) + 1);
    nJudge[j]! += 1;
    rJudge[j]! += o.y;
  }
  const S = Array.from({ length: J }, (_, i) => Array.from({ length: J }, (__, t) => (i === t ? nJudge[i]! + k : 0)));
  const rhs = [...rJudge];
  for (const row of rows.values()) {
    const entries = [...row.judges];
    for (const [a, ca] of entries) {
      rhs[a]! -= (ca * row.sum) / row.n;
      for (const [b, cb] of entries) S[a]![b]! -= (ca * cb) / row.n;
    }
  }
  const L = choleskyFactor(S);
  const b = solveFactored(L, rhs);
  const scores = new Map<string, number>();
  for (const [p, row] of rows) {
    let lean = 0;
    for (const [j, c] of row.judges) lean += c * b[j]!;
    scores.set(p, (row.sum - lean) / row.n);
  }
  const fit: Fit = { scores, leniency: new Map(judges.map((j, i) => [j, b[i]!])) };
  if (errors) {
    const inv = inverseFromFactor(L);
    const projectFactor = new Map<string, number>();
    for (const [p, row] of rows) {
      let q = 0;
      for (const [a, ca] of row.judges) for (const [c, cc] of row.judges) q += ca * cc * inv[a]![c]!;
      projectFactor.set(p, 1 / row.n + q / (row.n * row.n));
    }
    fit.factors = { scores: projectFactor, leniency: new Map(judges.map((j, i) => [j, inv[i]![i]!])) };
  }
  return fit;
}

/** The same fit on the full (projects + judges) system, one dense Cholesky. For the tests, and for k null. */
export function fitDense(obs: readonly Obs[], k: number | null, errors = false): Fit {
  const projects = sortedIds(obs.map((o) => o.projectId));
  const judges = sortedIds(obs.map((o) => o.judgeId));
  if (k === null) {
    const scores = new Map<string, number>();
    const factor = new Map<string, number>();
    for (const [p, list] of groupBy(obs, (o) => o.projectId)) {
      scores.set(p, list.reduce((s, o) => s + o.y, 0) / list.length);
      factor.set(p, 1 / list.length);
    }
    const leniency = new Map(judges.map((j) => [j, 0]));
    return errors ? { scores, leniency, factors: { scores: factor, leniency: new Map(leniency) } } : { scores, leniency };
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
  const L = choleskyFactor(A);
  const x = solveFactored(L, rhs);
  const fit: Fit = {
    scores: new Map(projects.map((p, i) => [p, x[i]!])),
    leniency: new Map(judges.map((j, i) => [j, x[P + i]!])),
  };
  if (errors) {
    const d = inverseDiagonal(L);
    fit.factors = { scores: new Map(projects.map((p, i) => [p, d[i]!])), leniency: new Map(judges.map((j, i) => [j, d[P + i]!])) };
  }
  return fit;
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

export type Normalization = Variance &
  Fit & {
    kUsed: number | null;
    /** when asked for: one standard error of each score and each leniency, √(σ̂² × factor) */
    se: { scores: Map<string, number>; leniency: Map<string, number> } | null;
  };

/** Estimate k from the data (or use a fixed one, for the comparison row) and fit. */
export function normalize(obs: readonly Obs[], opts: { fixedK?: number; errors?: boolean } = {}): Normalization {
  const variance = estimateVariance(obs);
  const kUsed = opts.fixedK ?? variance.k;
  const fit = fitLeniency(obs, kUsed, opts.errors ?? false);
  const se = (m: Map<string, number>) => new Map([...m].map(([id, f]) => [id, Math.sqrt(variance.sigma2 * f)]));
  return { ...variance, kUsed, ...fit, se: fit.factors ? { scores: se(fit.factors.scores), leniency: se(fit.factors.leniency) } : null };
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
