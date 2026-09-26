import { describe, expect, it } from "vitest";
import { choleskyInverseDiagonal, choleskySolve, fitLeniency, normalize, type Obs } from "@/server/judging/normalize";

// The ± on every score and leniency: one standard error from the fitted system,
// √(σ̂² × the inverse's diagonal). Checked three ways: the inverse's diagonal against
// an explicit inverse; the plain-mean case against σ̂² ÷ n; and by simulation, where
// 95 % intervals built from it must cover the true values 95 % of the time (and a
// halved or doubled ± must fail the same check).

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

/** 40 projects, 12 judges, three different judges per project, fixed by the seed. */
function design(seed: number) {
  const r = rng(seed);
  const judges = Array.from({ length: 12 }, (_, i) => `j${String(i).padStart(2, "0")}`);
  const pairs: { projectId: string; judgeId: string }[] = [];
  const truth = new Map<string, number>();
  for (let p = 0; p < 40; p++) {
    const projectId = `p${String(p).padStart(2, "0")}`;
    truth.set(projectId, r.normal());
    const pool = [...judges];
    for (let i = 0; i < 3; i++) pairs.push({ projectId, judgeId: pool.splice(Math.floor(r.uniform() * pool.length), 1)[0]! });
  }
  return { judges, pairs, truth };
}

/** judges: over every event; judgesFitted: only events where the data showed leniency (k not null), the only ones where the portal shows a judge's ± */
type Coverage = { projects: number; judges: number; judgesFitted: number; fittedShare: number };

/** Share of true values inside estimate ± z × scale × se, over many simulated events. */
function coverage(opts: { beta2: number; sigma2: number; reps: number; estimated: boolean; scale?: number }): Coverage {
  const { judges, pairs, truth } = design(7);
  const r = rng(20260927);
  const z = 1.959964;
  let pIn = 0;
  let pAll = 0;
  let jIn = 0;
  let jAll = 0;
  let fIn = 0;
  let fAll = 0;
  let fitted = 0;
  for (let rep = 0; rep < opts.reps; rep++) {
    const b = new Map(judges.map((j) => [j, Math.sqrt(opts.beta2) * r.normal()]));
    const obs: Obs[] = pairs.map((q) => ({ ...q, y: truth.get(q.projectId)! + b.get(q.judgeId)! + Math.sqrt(opts.sigma2) * r.normal() }));
    let scores: Map<string, number>;
    let leniency: Map<string, number>;
    let seScores: Map<string, number>;
    let seLeniency: Map<string, number>;
    let k: number | null = opts.sigma2 / opts.beta2;
    if (opts.estimated) {
      const fit = normalize(obs, { errors: true });
      ({ scores, leniency, k } = fit);
      seScores = fit.se!.scores;
      seLeniency = fit.se!.leniency;
    } else {
      const fit = fitLeniency(obs, opts.sigma2 / opts.beta2, true);
      ({ scores, leniency } = fit);
      seScores = new Map([...fit.factors!.scores].map(([id, f]) => [id, Math.sqrt(opts.sigma2 * f)]));
      seLeniency = new Map([...fit.factors!.leniency].map(([id, f]) => [id, Math.sqrt(opts.sigma2 * f)]));
    }
    const scale = opts.scale ?? 1;
    for (const [id, est] of scores) {
      pAll++;
      if (Math.abs(est - truth.get(id)!) <= z * scale * seScores.get(id)!) pIn++;
    }
    if (k !== null) fitted++;
    for (const [id, est] of leniency) {
      const inside = Math.abs(est - b.get(id)!) <= z * scale * seLeniency.get(id)!;
      jAll++;
      if (inside) jIn++;
      if (k !== null) {
        fAll++;
        if (inside) fIn++;
      }
    }
  }
  return { projects: pIn / pAll, judges: jIn / jAll, judgesFitted: fAll ? fIn / fAll : Number.NaN, fittedShare: fitted / opts.reps };
}

describe("standard errors of the normalization", () => {
  it("the inverse's diagonal matches an explicit inverse", () => {
    const r = rng(11);
    const n = 9;
    const M = Array.from({ length: n }, () => Array.from({ length: n }, () => r.normal()));
    const A = M.map((row, i) => row.map((_, j) => M[i]!.reduce((s, x, t) => s + x * M[j]![t]!, 0) + (i === j ? n : 0)));
    const fast = choleskyInverseDiagonal(A);
    const slow = A.map((_, i) => choleskySolve(A, A.map((__, t) => (t === i ? 1 : 0)))[i]!);
    fast.forEach((v, i) => expect(v).toBeCloseTo(slow[i]!, 10));
  });

  it("with no leniency correction, a score's ± is √(σ̂² ÷ n)", () => {
    const obs: Obs[] = [
      // a is high on p and low on q, b the other way round: no steady leniency
      { judgeId: "a", projectId: "p", y: 5 },
      { judgeId: "b", projectId: "p", y: 3 },
      { judgeId: "c", projectId: "p", y: 4 },
      { judgeId: "a", projectId: "q", y: 2 },
      { judgeId: "b", projectId: "q", y: 4 },
    ];
    const fit = normalize(obs, { errors: true });
    expect(fit.k).toBeNull();
    expect(fit.se!.scores.get("p")).toBeCloseTo(Math.sqrt(fit.sigma2 / 3), 12);
    expect(fit.se!.scores.get("q")).toBeCloseTo(Math.sqrt(fit.sigma2 / 2), 12);
    expect(fit.se!.leniency.get("a")).toBe(0);
  });

  it("asks nothing extra unless errors are wanted", () => {
    const fit = normalize([{ judgeId: "a", projectId: "p", y: 3 }]);
    expect(fit.se).toBeNull();
  });

  for (const [label, beta2, sigma2] of [
    ["strong leniency (k = 1.6)", 0.25, 0.4],
    ["the fixture's size of leniency (k = 43)", 0.01, 0.43],
  ] as const) {
    it(`95 % intervals cover the truth 95 % of the time, known variances, ${label}`, () => {
      const c = coverage({ beta2, sigma2, reps: 1500, estimated: false });
      expect(c.projects).toBeGreaterThan(0.94);
      expect(c.projects).toBeLessThan(0.96);
      expect(c.judges).toBeGreaterThan(0.93);
      expect(c.judges).toBeLessThan(0.97);
    });
  }

  it("known-bad: a halved or doubled ± fails the same check", () => {
    const half = coverage({ beta2: 0.25, sigma2: 0.4, reps: 300, estimated: false, scale: 0.5 });
    const twice = coverage({ beta2: 0.25, sigma2: 0.4, reps: 300, estimated: false, scale: 2 });
    expect(half.projects).toBeLessThan(0.94);
    expect(twice.projects).toBeGreaterThan(0.96);
    expect(half.judges).toBeLessThan(0.93);
    expect(twice.judges).toBeGreaterThan(0.97);
  });

  it("with the variances estimated from each event's own scores, as the portal runs", () => {
    const strong = coverage({ beta2: 0.25, sigma2: 0.4, reps: 1500, estimated: true });
    const fixtureLike = coverage({ beta2: 0.01, sigma2: 0.43, reps: 1500, estimated: true });
    const line = (c: Coverage) =>
      `projects ${c.projects.toFixed(3)}, judges ${c.judgesFitted.toFixed(3)} in the ${Math.round(c.fittedShare * 100)} % of events where leniency was fitted`;
    console.log(`coverage of 95 % intervals with estimated variances: strong leniency ${line(strong)}; fixture-like ${line(fixtureLike)}`);
    for (const c of [strong, fixtureLike]) {
      expect(c.projects).toBeGreaterThan(0.92);
      expect(c.projects).toBeLessThan(0.97);
      // a judge's ± is shown only when leniency was fitted; it runs a little short there, as plug-in errors do
      expect(c.judgesFitted).toBeGreaterThan(0.9);
      expect(c.judgesFitted).toBeLessThan(0.97);
    }
  });
});
