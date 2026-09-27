import "server-only";

// Pairwise mode (BUILD-PLAN decision 18; JUDGING.md "Pairwise mode"). A judge never
// gives a score: they place each project they were assigned into their own ranked list
// by answering "which is better?" about two projects at a time (binary insertion), and
// the event's ranking comes from every judge's answers through one Bradley-Terry fit:
//
//   logit P(the left project wins) = s_left - s_right + h + nu * (+1 if the project the
//   judge had just opened is on the left, -1 if it is on the right)
//
// s is each project's strength (prior N(0, 2^2), which also keeps a project that won
// everything finite); h is the pull of the left side and nu the pull of the project just
// opened, both estimated from the data (prior N(0, 0.5^2)) and reported, since sides are
// randomized per question and every project shows on both sides. "Too close to call"
// counts as half a win each way (the half-win approximation, not Davidson's tie model).
// A judge's finished rubric reviews in one track say "this is my order of these k
// projects" and enter the same fit as comparisons weighted 2/k each, so one judge's order
// counts as k - 1 comparisons (a weighting choice: one judge's say does not grow with the
// square of their load); a judge's picks in a track replace their score order there.
// Solved by Newton-Raphson on the concave log-posterior; uncertainties come from the
// inverse Hessian (Laplace). Strengths compare within a track only. Pure: no database.

export type Outcome = 1 | 0.5 | 0;

export type Comparison = {
  judgeId: string;
  trackId: string;
  /** a pick: the project shown on the left; a pair from scores: either one */
  a: string;
  /** a pick: the project shown on the right */
  b: string;
  /** 1: a is better, 0: b is better, 0.5: too close to call */
  y: Outcome;
  /** 1 for a pick, 2/k for a pair implied by one judge's scores of k projects in a track */
  weight: number;
  kind: "pick" | "scores";
  /** a pick: which side held the project the judge had just opened */
  newIs: "a" | "b" | null;
};

export type ProjectFit = {
  id: string;
  trackId: string;
  s: number;
  se: number;
  /** chance of beating a typical project of its track, σ(s - mean of the track), and one standard error */
  winPct: number;
  winPctSe: number;
  comparisons: number;
  picks: number;
  /** projects joined by comparisons share a group; a track split into groups was never compared across them */
  group: number;
  /** 1 = best in its track; projects never compared come last */
  place: number;
  /** the chance this project really is ahead of the next one in its track */
  beatsNext: number | null;
};

export type Bias = { est: number; se: number } | null;

export type PairwiseFit = {
  projects: ProjectFit[];
  /** the pull of the left side, in logits; null without picks */
  left: Bias;
  /** the pull of the project the judge had just opened, in logits; null without picks */
  fresh: Bias;
  tracks: { trackId: string; groups: number }[];
  converged: boolean;
  iterations: number;
};

export const SIGMA_STRENGTH = 2;
export const SIGMA_BIAS = 0.5;

export const sigmoid = (x: number) => (x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x)));

/** Standard normal CDF (erfc by Numerical Recipes' Chebyshev fit, |error| < 1.2e-7). */
export function normalCdf(x: number): number {
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

/**
 * The pairs one judge's finished reviews imply, per track: every two projects the judge
 * scored in the same track, the higher total winning (equal totals: too close to call),
 * each weighted 2/k. `replaced` holds "judgeId|trackId" for judges whose picks in that
 * track replace their score order.
 */
export function impliedFromScores(
  reviews: { judgeId: string; trackId: string; projectId: string; total: number }[],
  replaced: ReadonlySet<string> = new Set(),
): Comparison[] {
  const groups = new Map<string, { judgeId: string; trackId: string; rows: { projectId: string; total: number }[] }>();
  for (const r of reviews) {
    const key = `${r.judgeId}|${r.trackId}`;
    if (replaced.has(key)) continue;
    const g = groups.get(key) ?? { judgeId: r.judgeId, trackId: r.trackId, rows: [] };
    g.rows.push({ projectId: r.projectId, total: r.total });
    groups.set(key, g);
  }
  const out: Comparison[] = [];
  for (const g of groups.values()) {
    const rows = [...g.rows].sort((x, y) => x.projectId.localeCompare(y.projectId));
    const k = rows.length;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const a = rows[i]!;
        const b = rows[j]!;
        const y: Outcome = Math.abs(a.total - b.total) < 1e-9 ? 0.5 : a.total > b.total ? 1 : 0;
        out.push({ judgeId: g.judgeId, trackId: g.trackId, a: a.projectId, b: b.projectId, y, weight: 2 / k, kind: "scores", newIs: null });
      }
    }
  }
  return out;
}

/** One Bradley-Terry fit of every comparison, with the left-side and just-opened pulls. */
export function fitPairwise(
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
      if (next && r.comparisons > 0 && next.comparisons > 0) {
        const sd = Math.sqrt(Math.max(1e-18, cov[r._i]![r._i]! + cov[next._i]![next._i]! - 2 * cov[r._i]![next._i]!));
        r.beatsNext = normalCdf((r.s - next.s) / sd);
      }
    });
    for (const { _i: _drop, ...r } of rowsFit) out.push(r);
  }
  const bias = (k: number): Bias => (hasPicks ? { est: theta[k]!, se: Math.sqrt(cov[k]![k]!) } : null);
  return { projects: out, left: bias(H_), fresh: bias(NU), tracks: trackSummary, converged, iterations };
}

export const MIN_PICKS_FOR_FLAG = 6;
/**
 * The flag: a judge's picks agree with the rest of the panel no better than coin flips
 * would (z below this), or more than half their answers are "too close to call". The
 * threshold was set with the Monte Carlo (tests/pairwise-mc.test.ts) under a bound
 * declared first: honest judges flagged at most 15 % of the time. Like the flat-judge
 * flag it is a prompt for the organizer, who keeps or leaves out the judge with a reason.
 */
export const COIN_FLIP_Z = 0;
export const TIE_RATE_FLAG = 0.5;

export type Agreement = {
  judgeId: string;
  picks: number;
  ties: number;
  /** the judge's picks weighted by how sure the rest of the panel is, |2p - 1| */
  weight: number;
  /** weighted share of picks that agree with the rest of the panel (a tie earns 1/2) */
  share: number | null;
  /** (agreement - what coin flips earn) / its standard deviation under coin flips */
  z: number | null;
};

/**
 * How far one judge's picks agree with everyone else's: refit without that judge (their
 * picks and their score order both out), then weigh each of their picks by how sure the
 * rest of the panel is about that pair. A judge who answers at random scores z near 0.
 */
export function judgeAgreement(tracks: { trackId: string; projectIds: string[] }[], comparisons: Comparison[], judgeId: string): Agreement {
  const mine = comparisons.filter((c) => c.judgeId === judgeId && c.kind === "pick");
  const ties = mine.filter((c) => c.y === 0.5).length;
  if (mine.length < MIN_PICKS_FOR_FLAG) return { judgeId, picks: mine.length, ties, weight: 0, share: null, z: null };
  const rest = fitPairwise(
    tracks,
    comparisons.filter((c) => c.judgeId !== judgeId),
  );
  const s = new Map(rest.projects.map((p) => [p.id, p.s]));
  let W = 0;
  let A = 0;
  let V = 0;
  for (const c of mine) {
    const p = sigmoid((s.get(c.a) ?? 0) - (s.get(c.b) ?? 0));
    const w = Math.abs(2 * p - 1);
    const agree = c.y === 0.5 ? 0.5 : (c.y === 1) === p > 0.5 ? 1 : 0;
    W += w;
    A += w * agree;
    V += 0.25 * w * w;
  }
  if (V <= 1e-12) return { judgeId, picks: mine.length, ties, weight: W, share: null, z: null };
  return { judgeId, picks: mine.length, ties, weight: W, share: A / W, z: (A - 0.5 * W) / Math.sqrt(V) };
}

/** Stable left/right for a question: the same judge, project and opponent always get the same sides. */
export function newOnLeft(judgeId: string, newId: string, against: string): boolean {
  let h = 0x811c9dc5;
  for (const ch of `${judgeId}|${newId}|${against}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 1) === 1;
}

export type PickRecord = { left: string; right: string; newId: string; outcome: "left" | "right" | "tie" };

export type Question = { newId: string; against: string; left: string; right: string };

export type InsertionState = {
  /** the judge's list so far, best first */
  list: string[];
  /** the question to answer now, or null when every project is placed */
  current: Question | null;
  placed: number;
  total: number;
  /** picks that no longer fit the replay (a project merged away, a stale pair); kept out of the list */
  ignored: number;
};

/**
 * Replay one judge's picks in one track into their list and the next question. `queue`
 * is the judge's projects in the order to open them (the caller sorts: fewest comparisons
 * first, a seeded tie-break); a project already being placed is always finished first.
 * Binary insertion: the new project is compared with the middle of the range it can
 * still take; a tie places it right below the tied project.
 */
export function replayInsertion(judgeId: string, queue: string[], picks: PickRecord[]): InsertionState {
  const assigned = new Set(queue);
  const list: string[] = [];
  let ignored = 0;
  let inserting: { id: string; lo: number; hi: number } | null = null;
  const opened = new Set<string>();

  const expected = (): Question | null => {
    if (!inserting) return null;
    const mid = Math.floor((inserting.lo + inserting.hi) / 2);
    const against = list[mid]!;
    const left = newOnLeft(judgeId, inserting.id, against);
    return { newId: inserting.id, against, left: left ? inserting.id : against, right: left ? against : inserting.id };
  };
  const place = (at: number) => {
    list.splice(at, 0, inserting!.id);
    inserting = null;
  };

  for (const p of picks) {
    if (!assigned.has(p.newId)) {
      ignored++;
      continue;
    }
    if (!inserting) {
      if (opened.has(p.newId)) {
        ignored++;
        continue;
      }
      if (list.length === 0) {
        // The first question: its other project is the judge's first, placed without a question.
        const other = p.left === p.newId ? p.right : p.left;
        if (!assigned.has(other) || other === p.newId) {
          ignored++;
          continue;
        }
        list.push(other);
        opened.add(other);
      }
      inserting = { id: p.newId, lo: 0, hi: list.length };
      opened.add(p.newId);
    }
    const q = expected()!;
    if (p.newId !== q.newId || p.left !== q.left || p.right !== q.right) {
      ignored++;
      continue;
    }
    const cur: { id: string; lo: number; hi: number } = inserting!;
    const mid = Math.floor((cur.lo + cur.hi) / 2);
    const newWon = p.outcome === "tie" ? null : (p.outcome === "left") === (q.left === cur.id);
    if (newWon === null) place(mid + 1);
    else {
      if (newWon) cur.hi = mid;
      else cur.lo = mid + 1;
      if (cur.lo >= cur.hi) place(cur.lo);
    }
  }

  if (!inserting) {
    const nextId = queue.find((id) => !opened.has(id));
    if (nextId !== undefined) {
      if (list.length === 0) {
        // Nothing to compare the first project with: it is placed, and the next one is asked about.
        list.push(nextId);
        opened.add(nextId);
        const second = queue.find((id) => !opened.has(id));
        if (second !== undefined) {
          inserting = { id: second, lo: 0, hi: 1 };
          opened.add(second);
        }
      } else {
        inserting = { id: nextId, lo: 0, hi: list.length };
        opened.add(nextId);
      }
    }
  }
  return { list: [...list], current: expected(), placed: list.length, total: queue.length, ignored };
}
