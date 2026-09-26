import { describe, expect, it } from "vitest";
import { fitDense, fitLeniency, normalize, type Obs } from "@/server/judging/normalize";

// The fit eliminates the project levels first and solves one judge × judge system.
// Held here against the full dense system on uneven designs (projects with one to
// five reviews, judges with a single review), and timed on an event of 1,000
// projects, where the full system would have 1,150 rows.

function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

function event(seed: number, projects: number, judges: number, reviews: () => number): Obs[] {
  const r = rng(seed);
  const ids = Array.from({ length: judges }, (_, i) => `j${i}`);
  const lean = ids.map(() => 0.4 * r.normal());
  const obs: Obs[] = [];
  for (let p = 0; p < projects; p++) {
    const level = 3 + 0.6 * r.normal();
    const pool = [...ids.keys()];
    for (let i = Math.min(reviews(), judges); i > 0; i--) {
      const j = pool.splice(Math.floor(r.uniform() * pool.length), 1)[0]!;
      obs.push({ projectId: `p${p}`, judgeId: ids[j]!, y: level + lean[j]! + 0.5 * r.normal() });
    }
  }
  return obs;
}

const worst = (a: Map<string, number>, b: Map<string, number>) => {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  return Math.max(...[...a].map(([id, v]) => Math.abs(v - b.get(id)!)));
};

// 60 s budget: under the whole suite in parallel this test shares the CPU (the Monte Carlo test does the same)
describe("the fit at scale", { timeout: 60_000 }, () => {
  it("agrees with the full dense system on uneven designs: scores, leniencies and the ± factors", () => {
    for (const seed of [1, 2, 3]) {
      const r = rng(seed * 101);
      const obs = event(seed, 60, 14, () => 1 + Math.floor(r.uniform() * 5));
      for (const k of [0.5, 4, 42.6]) {
        const fast = fitLeniency(obs, k, true);
        const full = fitDense(obs, k, true);
        expect(worst(fast.scores, full.scores)).toBeLessThan(1e-10);
        expect(worst(fast.leniency, full.leniency)).toBeLessThan(1e-10);
        expect(worst(fast.factors!.scores, full.factors!.scores)).toBeLessThan(1e-10);
        expect(worst(fast.factors!.leniency, full.factors!.leniency)).toBeLessThan(1e-10);
      }
    }
  });

  it("known-bad: dropping one review from the fast fit's input breaks the agreement", () => {
    const obs = event(9, 40, 10, () => 3);
    const fast = fitLeniency(obs.slice(1), 4, true);
    const full = fitDense(obs, 4, true);
    expect(worst(fast.leniency, full.leniency)).toBeGreaterThan(1e-6);
  });

  it("fits an event of 1,000 projects and 150 judges, with errors, and reruns it once per judge, in seconds", () => {
    const obs = event(20260927, 1000, 150, () => 3);
    const t0 = performance.now();
    const fit = normalize(obs, { errors: true });
    const once = performance.now() - t0;
    const judges = [...new Set(obs.map((o) => o.judgeId))];
    const t1 = performance.now();
    for (const j of judges) normalize(obs.filter((o) => o.judgeId !== j));
    const influence = performance.now() - t1;
    const t2 = performance.now();
    fitDense(obs, fit.k, true);
    const dense = performance.now() - t2;
    console.log(
      `1,000 projects, 150 judges, ${obs.length} reviews: one fit with errors ${once.toFixed(0)} ms; the influence check's 150 refits ${influence.toFixed(0)} ms; the full 1,150-row system, once, ${dense.toFixed(0)} ms`,
    );
    expect(fit.scores.size).toBe(1000);
    expect(fit.k).not.toBeNull();
    // a loose bound, far above the measured time and far below 150 dense refits
    expect(once + influence).toBeLessThan(20_000);
  });
});
