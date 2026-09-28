// The pairwise fit as it stood before the per-track solve (commit c2963d7, src/server/judging/pairwise.ts):
// one dense Cholesky of the whole information matrix. Kept here, verbatim, as the oracle the
// per-track solve is held to (tests/pairwise-engine.test.ts). Not used by the app.
import type { Bias, Comparison, PairwiseFit, ProjectFit } from "@/server/judging/pairwise";
import { SIGMA_BIAS, SIGMA_STRENGTH } from "@/server/judging/pairwise";

const sigmoid = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

/** Standard normal CDF (erfc by Numerical Recipes' Chebyshev fit, |error| < 1.2e-7). */
function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.5 * z);
  const erfc =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? 1 - erfc / 2 : erfc / 2;
}

/** Lower-triangular L with L Lᵀ = A, for a symmetric positive definite A. */
function cholesky(A: number[][]): number[][] {
  const n = A.length;
  const L = A.map(() => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i]![j]!;
      for (let k = 0; k < j; k++) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        if (sum <= 0) throw new Error("pairwise fit: the information matrix is not positive definite");
        L[i]![i] = Math.sqrt(sum);
      } else L[i]![j] = sum / L[j]![j]!;
    }
  }
  return L;
}

function cholSolve(L: number[][], b: number[]): number[] {
  const n = L.length;
  const y = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= L[i]![k]! * y[k]!;
    y[i] = sum / L[i]![i]!;
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= L[k]![i]! * x[k]!;
    x[i] = sum / L[i]![i]!;
  }
  return x;
}

function inverse(L: number[][]): number[][] {
  const n = L.length;
  const cols = Array.from({ length: n }, (_, j) => cholSolve(L, Array.from({ length: n }, (_, i) => (i === j ? 1 : 0))));
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => cols[j]![i]!));
}


/** One Bradley-Terry fit of every comparison, with the left-side and just-opened pulls. */
export function fitPairwiseDense(
  tracks: { trackId: string; projectIds: string[] }[],
  comparisons: Comparison[],
  opts: { sigmaStrength?: number; sigmaBias?: number; maxIterations?: number } = {},
): PairwiseFit {
  const sigmaS = opts.sigmaStrength ?? SIGMA_STRENGTH;
  const sigmaB = opts.sigmaBias ?? SIGMA_BIAS;
  const ids: string[] = [];
  const trackOf = new Map<string, string>();
  for (const t of tracks) {
    for (const id of t.projectIds) {
      if (trackOf.has(id)) continue;
      trackOf.set(id, t.trackId);
      ids.push(id);
    }
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  const P = ids.length;
  const H_ = P; // index of h
  const NU = P + 1; // index of nu
  const n = P + 2;
  const usable = comparisons.filter((c) => c.weight > 0 && c.a !== c.b && index.has(c.a) && index.has(c.b) && trackOf.get(c.a) === trackOf.get(c.b));
  const hasPicks = usable.some((c) => c.kind === "pick");

  // Each comparison's design: the parameters it touches, with their coefficients.
  const rows = usable.map((c) => {
    const terms: [number, number][] = [
      [index.get(c.a)!, 1],
      [index.get(c.b)!, -1],
    ];
    if (c.kind === "pick") {
      terms.push([H_, 1]);
      if (c.newIs) terms.push([NU, c.newIs === "a" ? 1 : -1]);
    }
    return { terms, y: c.y, w: c.weight };
  });
  const prior = Array.from({ length: n }, (_, i) => 1 / (i < P ? sigmaS * sigmaS : sigmaB * sigmaB));
  const theta = new Array<number>(n).fill(0);

  const evaluate = (th: number[]) => {
    let logPost = 0;
    const g = th.map((v, i) => -prior[i]! * v);
    const H = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? prior[i]! : 0))); // -Hessian
    for (let i = 0; i < n; i++) logPost -= 0.5 * prior[i]! * th[i]! * th[i]!;
    for (const r of rows) {
      let x = 0;
      for (const [k, v] of r.terms) x += v * th[k]!;
      const p = sigmoid(x);
      logPost += r.w * (r.y * Math.log(Math.max(p, 1e-300)) + (1 - r.y) * Math.log(Math.max(1 - p, 1e-300)));
      const resid = r.w * (r.y - p);
      const curv = r.w * p * (1 - p);
      for (const [k, v] of r.terms) {
        g[k] = g[k]! + resid * v;
        for (const [l, u] of r.terms) H[k]![l] = H[k]![l]! + curv * v * u;
      }
    }
    return { logPost, g, H };
  };

  let state = evaluate(theta);
  let iterations = 0;
  let converged = false;
  const maxIt = opts.maxIterations ?? 100;
  while (iterations < maxIt) {
    iterations++;
    const L = cholesky(state.H);
    const step = cholSolve(L, state.g);
    let scale = 1;
    let next = theta.map((v, i) => v + step[i]!);
    let trial = evaluate(next);
    // The log-posterior is concave, so a full step almost always helps; halve it if not.
    while (trial.logPost < state.logPost - 1e-12 && scale > 1e-6) {
      scale /= 2;
      next = theta.map((v, i) => v + scale * step[i]!);
      trial = evaluate(next);
    }
    for (let i = 0; i < n; i++) theta[i] = next[i]!;
    state = trial;
    if (Math.max(...step.map((s) => Math.abs(s * scale))) < 1e-10) {
      converged = true;
      break;
    }
  }
  const cov = inverse(cholesky(state.H));

  // Counts and groups (union-find over the comparisons, within each track).
  const parent = ids.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const count = new Array<number>(P).fill(0);
  const picks = new Array<number>(P).fill(0);
  for (const c of usable) {
    const i = index.get(c.a)!;
    const j = index.get(c.b)!;
    count[i]!++;
    count[j]!++;
    if (c.kind === "pick") {
      picks[i]!++;
      picks[j]!++;
    }
    parent[find(i)] = find(j);
  }

  const out: ProjectFit[] = [];
  const trackSummary: { trackId: string; groups: number }[] = [];
  for (const t of tracks) {
    const members = t.projectIds.filter((id) => trackOf.get(id) === t.trackId).map((id) => index.get(id)!);
    if (members.length === 0) {
      trackSummary.push({ trackId: t.trackId, groups: 0 });
      continue;
    }
    const m = members.length;
    const mean = members.reduce((acc, i) => acc + theta[i]!, 0) / m;
    const roots = new Map<number, number>();
    for (const i of members) if (count[i]! > 0 && !roots.has(find(i))) roots.set(find(i), roots.size);
    trackSummary.push({ trackId: t.trackId, groups: roots.size });
    // Var(s_i - mean) = cov_ii - 2/m * sum_j cov_ij + 1/m^2 * sum_jk cov_jk
    let all = 0;
    for (const j of members) for (const k of members) all += cov[j]![k]!;
    const rowsFit = members.map((i) => {
      let row = 0;
      for (const j of members) row += cov[i]![j]!;
      const v = Math.max(0, cov[i]![i]! - (2 / m) * row + all / (m * m));
      const p = sigmoid(theta[i]! - mean);
      return {
        id: ids[i]!,
        trackId: t.trackId,
        s: theta[i]!,
        se: Math.sqrt(cov[i]![i]!),
        winPct: p,
        winPctSe: p * (1 - p) * Math.sqrt(v),
        comparisons: count[i]!,
        picks: picks[i]!,
        group: count[i]! > 0 ? roots.get(find(i))! : -1,
        place: 0,
        beatsNext: null as number | null,
        _i: i,
      };
    });
    rowsFit.sort((x, y) => Number(y.comparisons > 0) - Number(x.comparisons > 0) || y.s - x.s || x.id.localeCompare(y.id));
    rowsFit.forEach((r, k) => {
      r.place = k + 1;
      const next = rowsFit[k + 1];
      // Only within a group: across groups never compared, the difference is the prior's, not evidence.
      if (next && r.comparisons > 0 && next.comparisons > 0 && find(r._i) === find(next._i)) {
        const sd = Math.sqrt(Math.max(1e-18, cov[r._i]![r._i]! + cov[next._i]![next._i]! - 2 * cov[r._i]![next._i]!));
        r.beatsNext = normalCdf((r.s - next.s) / sd);
      }
    });
    for (const { _i: _drop, ...r } of rowsFit) out.push(r);
  }
  const bias = (k: number): Bias => (hasPicks ? { est: theta[k]!, se: Math.sqrt(cov[k]![k]!) } : null);
  return { projects: out, left: bias(H_), fresh: bias(NU), tracks: trackSummary, converged, iterations };
}
