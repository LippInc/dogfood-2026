import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { flatJudges } from "@/server/judging/flat";
import { normalize, type Obs } from "@/server/judging/normalize";

// Decision 11's validation: a Monte Carlo on the fixture's own 126 judge-project
// pairs. Each run draws true project qualities, judge offsets and scales, review
// noise, rounds and clips to the 1–5 rubric, and keeps the fixture's flat judge
// scoring its real 4/4/4. Methods: the raw mean (every judge), the engine at k = 3
// (the 09-23 comparison row) and the engine with k estimated (what ships). Score:
// Kendall tau-b against the truth over project pairs in the same track ("within")
// and over all pairs ("pooled"). Three assertions, margins declared before the run
// (BUILD-PLAN decision 11); a red one is a stop-and-tell, never a change of engine.

const RUNS = 1000;
const SEED = 20260923;
const NOISE = 0.3;
const HALO = 0.6;

type Fixture = {
  judges: { id: string }[];
  projects: { id: string; track: string }[];
  scores: { judge: string; project: string; criteria: Record<string, number> }[];
};
const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8")) as Fixture;
const CRIT = ["functionality", "quality", "innovation"];

// The design, by sorted index, as the planning script builds it.
const projects = fx.projects.map((p) => p.id).sort();
const judges = fx.judges.map((j) => j.id).sort();
const pIndex = new Map(projects.map((p, i) => [p, i]));
const jIndex = new Map(judges.map((j, i) => [j, i]));
const trackOf = new Map(fx.projects.map((p) => [p.id, p.track]));
const tracks = projects.map((p) => trackOf.get(p)!);
const pairs = fx.scores.map((s) => [jIndex.get(s.judge)!, pIndex.get(s.project)!] as const);
const real = fx.scores.map((s) => CRIT.map((c) => s.criteria[c]!));
const nP = projects.length;
const nJ = judges.length;
const within: [number, number][] = [];
const pooled: [number, number][] = [];
for (let a = 0; a < nP; a++) {
  for (let b = a + 1; b < nP; b++) {
    pooled.push([a, b]);
    if (tracks[a] === tracks[b]) within.push([a, b]);
  }
}
const batch = new Map<number, number[]>();
pairs.forEach(([j, p]) => batch.set(j, [...(batch.get(j) ?? []), p].sort((x, y) => x - y)));
const realFlat = flatJudges(pairs.map(([j, p], i) => ({ judgeId: String(j), projectId: String(p), values: real[i]! })));
const flatJ = realFlat.length === 1 ? Number(realFlat[0]!.judgeId) : null;
const flatVec = flatJ === null ? null : real[pairs.findIndex(([j]) => j === flatJ)]!;

/** H: the busiest non-flat judge whose batch leaves part of each of its tracks; L: the next such judge sharing no project with H. */
function confoundJudges(): [number, number] {
  const perTrack = new Map<string, Set<number>>();
  tracks.forEach((t, p) => perTrack.set(t, (perTrack.get(t) ?? new Set()).add(p)));
  const cand: number[] = [];
  for (const [j, ps] of batch) {
    if (j === flatJ || ps.length < 3) continue;
    const byTrack = new Map<string, Set<number>>();
    for (const p of ps) byTrack.set(tracks[p]!, (byTrack.get(tracks[p]!) ?? new Set()).add(p));
    if ([...byTrack].every(([t, s]) => s.size < perTrack.get(t)!.size)) cand.push(j);
  }
  cand.sort((a, b) => batch.get(b)!.length - batch.get(a)!.length || (judges[a]! < judges[b]! ? -1 : 1));
  const H = cand[0]!;
  const L = cand.slice(1).find((j) => !batch.get(j)!.some((p) => batch.get(H)!.includes(p)))!;
  return [H, L];
}
const [H, L] = confoundJudges();

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): () => number {
  return () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

type Scenario = { key: string; su: number; sv: number; ss: number; halo: number; confound: "on" | null };
const mod = { su: 0.4, sv: 0.2, ss: 0.2 };
const SCENARIOS: Scenario[] = [
  { key: "no-bias control", su: 0, sv: 0, ss: 0, halo: 0, confound: null },
  { key: "moderate bias", ...mod, halo: 0, confound: null },
  { key: "moderate bias, noisy judges", ...mod, halo: HALO, confound: null },
  { key: "batch confound (known-bad for leniency)", ...mod, halo: 0, confound: "on" },
];

/** One simulated event on the fixture's pairs; the same base draws for every scenario of a run. */
function simulate(sc: Scenario, run: number): { q: number[]; reviews: { j: number; p: number; v: number[] }[] } {
  const g = gauss(rng((SEED * 1_000_003 + run * 7919) >>> 0));
  const zq = Array.from({ length: nP }, g);
  const zu = Array.from({ length: nJ }, g);
  const zv = Array.from({ length: nJ }, () => [g(), g(), g()]);
  const zs = Array.from({ length: nJ }, g);
  const ze = pairs.map(() => [g(), g(), g()]);
  const zh = pairs.map(g);
  const q = [...zq];
  const u = zu.map((z) => sc.su * z);
  if (sc.confound === "on") {
    // The harshest judge gets a genuinely stronger batch, the most lenient a weaker one.
    const hb = batch.get(H)!;
    const lb = batch.get(L)!;
    const rest = Array.from({ length: nP }, (_, p) => p).filter((p) => !hb.includes(p) && !lb.includes(p));
    const vals = [...zq].sort((a, b) => b - a);
    const r2 = rng((SEED ^ (run * 2654435761)) >>> 0);
    const shuffle = (xs: number[]) => {
      for (let i = xs.length - 1; i > 0; i--) {
        const k = Math.floor(r2() * (i + 1));
        [xs[i], xs[k]] = [xs[k]!, xs[i]!];
      }
      return xs;
    };
    const top = shuffle(vals.slice(0, hb.length));
    const bottom = shuffle(vals.slice(nP - lb.length));
    const middle = shuffle(vals.slice(hb.length, nP - lb.length));
    hb.forEach((p, i) => (q[p] = top[i]!));
    lb.forEach((p, i) => (q[p] = bottom[i]!));
    rest.forEach((p, i) => (q[p] = middle[i]!));
    const jmin = u.reduce((m, x, j) => (x < u[m]! ? j : m), 0);
    [u[H], u[jmin]] = [u[jmin]!, u[H]!];
    const jmax = u.reduce((m, x, j) => (x > u[m]! ? j : m), 0);
    [u[L], u[jmax]] = [u[jmax]!, u[L]!];
  }
  const scale = zs.map((z) => Math.exp(sc.ss * z));
  const reviews = pairs.map(([j, p], i) => {
    if (j === flatJ) return { j, p, v: [...flatVec!] };
    const v = [0, 1, 2].map((c) => {
      const x = 3 + scale[j]! * (q[p]! + NOISE * ze[i]![c]! + sc.halo * zh[i]!) + u[j]! + sc.sv * zv[j]![c]!;
      return Math.floor(Math.min(5, Math.max(1, x)) + 0.5);
    });
    return { j, p, v };
  });
  return { q, reviews };
}

function tauB(x: number[], y: number[], over: [number, number][]): number {
  let conc = 0;
  let disc = 0;
  let tx = 0;
  let ty = 0;
  for (const [a, b] of over) {
    const dx = x[a]! - x[b]!;
    const dy = y[a]! - y[b]!;
    const zx = Math.abs(dx) <= 1e-12;
    const zy = Math.abs(dy) <= 1e-12;
    if (zx) tx++;
    if (zy) ty++;
    if (zx || zy) continue;
    if (dx > 0 === dy > 0) conc++;
    else disc++;
  }
  const den = Math.sqrt((over.length - tx) * (over.length - ty));
  return den > 0 ? (conc - disc) / den : Number.NaN;
}

type Method = (reviews: { j: number; p: number; v: number[] }[]) => number[];
const rawMean: Method = (reviews) => {
  const sum = new Array<number>(nP).fill(0);
  const cnt = new Array<number>(nP).fill(0);
  for (const r of reviews) {
    sum[r.p]! += r.v.reduce((s, x) => s + x, 0);
    cnt[r.p]! += r.v.length;
  }
  return sum.map((s, p) => (cnt[p] ? s / cnt[p]! : 0));
};
const engine =
  (fixedK?: number, shift = 0): Method =>
  (reviews) => {
    const flat = new Set(flatJudges(reviews.map((r) => ({ judgeId: String(r.j), projectId: String(r.p), values: r.v }))).map((f) => f.judgeId));
    const obs: Obs[] = reviews
      .filter((r) => !flat.has(String(r.j)))
      .map((r) => ({ judgeId: String(r.j), projectId: String((r.p + shift) % nP), y: (r.v[0]! + r.v[1]! + r.v[2]!) / 3 }));
    const fit = normalize(obs, fixedK === undefined ? {} : { fixedK });
    return Array.from({ length: nP }, (_, p) => fit.scores.get(String(p)) ?? 0);
  };

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

type Taus = { within: number[]; pooled: number[] };
function run(sc: Scenario, methods: Record<string, Method>, runs = RUNS): Record<string, Taus> {
  const out: Record<string, Taus> = Object.fromEntries(Object.keys(methods).map((k) => [k, { within: [], pooled: [] }]));
  for (let r = 0; r < runs; r++) {
    const { q, reviews } = simulate(sc, r);
    for (const [k, m] of Object.entries(methods)) {
      const x = m(reviews);
      out[k]!.within.push(tauB(x, q, within));
      out[k]!.pooled.push(tauB(x, q, pooled));
    }
  }
  return out;
}

const METHODS = { raw: rawMean, "k = 3": engine(3), engine: engine() };
const results = new Map<string, Record<string, Taus>>();
function resultsFor(key: string) {
  if (!results.has(key)) results.set(key, run(SCENARIOS.find((s) => s.key === key)!, METHODS));
  return results.get(key)!;
}

// 1,000 simulated events per scenario: the first test to ask pays for them, which
// takes over 5 s when the whole suite runs in parallel, so this file gets 60 s.
describe("normalization Monte Carlo on the fixture's pairs (decision 11)", { timeout: 60_000 }, () => {
  it("uses the fixture's design: 126 pairs, one flat judge, two confound judges", () => {
    expect(pairs).toHaveLength(126);
    expect(flatJ).not.toBeNull();
    expect(judges[flatJ!]).toBe("jdg_07");
    expect(H).not.toBe(L);
  });

  it("prints the table: mean Kendall tau (run-to-run sd) per scenario and method", () => {
    const lines = ["| scenario | method | within-track tau | pooled tau |", "|---|---|---|---|"];
    for (const sc of SCENARIOS) {
      const r = resultsFor(sc.key);
      for (const [m, t] of Object.entries(r)) {
        lines.push(`| ${sc.key} | ${m} | ${mean(t.within).toFixed(3)} (sd ${sd(t.within).toFixed(3)}) | ${mean(t.pooled).toFixed(3)} (sd ${sd(t.pooled).toFixed(3)}) |`);
      }
    }
    console.log(`${RUNS} runs per scenario, seed ${SEED}\n${lines.join("\n")}`);
    expect(lines.length).toBe(2 + SCENARIOS.length * 3);
    // JUDGING.md carries this very table: every row must appear there as printed
    const doc = fs.readFileSync(path.join(process.cwd(), "JUDGING.md"), "utf8");
    const missing = lines.slice(2).filter((line) => !doc.includes(line));
    expect(missing, "rows of the Monte Carlo table that JUDGING.md does not state as printed").toEqual([]);
  });

  it("(1) no-bias control: loses to the raw mean by no more than the sd of the per-run difference, within-track and pooled", () => {
    const r = resultsFor("no-bias control");
    for (const key of ["within", "pooled"] as const) {
      const diff = r.engine![key].map((x, i) => x - r.raw![key][i]!);
      expect(mean(diff), `${key}: mean ${mean(diff).toFixed(4)} sd ${sd(diff).toFixed(4)}`).toBeGreaterThanOrEqual(-sd(diff));
    }
  });

  it("(2) batch confound: the engine's pooled tau is not below the raw mean's", () => {
    const r = resultsFor("batch confound (known-bad for leniency)");
    expect(mean(r.engine!.pooled)).toBeGreaterThanOrEqual(mean(r.raw!.pooled));
  });

  it("(3) moderate bias, with and without noisy judges: trails k = 3 by at most 0.010 within-track and 0.020 pooled", () => {
    for (const key of ["moderate bias", "moderate bias, noisy judges"]) {
      const r = resultsFor(key);
      expect(mean(r["k = 3"]!.within) - mean(r.engine!.within), `${key} within`).toBeLessThanOrEqual(0.01);
      expect(mean(r["k = 3"]!.pooled) - mean(r.engine!.pooled), `${key} pooled`).toBeLessThanOrEqual(0.02);
    }
  });

  it("reports how often the flat-judge rule flags an honest judge (the rule is a reversible flag for this reason)", () => {
    const lines: string[] = [];
    for (const sc of SCENARIOS.slice(0, 3)) {
      let panels = 0;
      for (let r = 0; r < RUNS; r++) {
        const { reviews } = simulate(sc, r);
        const flags = flatJudges(reviews.map((x) => ({ judgeId: String(x.j), projectId: String(x.p), values: x.v })));
        if (flags.some((f) => Number(f.judgeId) !== flatJ)) panels++;
      }
      lines.push(`${sc.key}: an honest judge flagged in ${((panels / RUNS) * 100).toFixed(1)} % of ${RUNS} simulated panels`);
    }
    console.log(lines.join("\n"));
    // fixed seeds: the rates JUDGING.md states
    expect(lines).toEqual([
      "no-bias control: an honest judge flagged in 7.7 % of 1000 simulated panels",
      "moderate bias: an honest judge flagged in 8.0 % of 1000 simulated panels",
      "moderate bias, noisy judges: an honest judge flagged in 6.2 % of 1000 simulated panels",
    ]);
  });

  it("known-bad: an engine with shifted project indices fails assertion (1)", () => {
    const control = SCENARIOS[0]!;
    const r = run(control, { raw: rawMean, shifted: engine(undefined, 1) }, 100);
    const diff = r.shifted!.within.map((x, i) => x - r.raw!.within[i]!);
    console.log(`shifted engine, control, 100 runs: mean within diff ${mean(diff).toFixed(3)} (sd ${sd(diff).toFixed(3)})`);
    expect(mean(diff)).toBeLessThan(-sd(diff));
    expect(mean(diff)).toBeCloseTo(-0.961, 3); // the figure JUDGING.md quotes
  });
});
