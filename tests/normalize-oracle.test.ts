import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { finishedReviews, rubricOf, weightedTotal } from "@/server/dal/judging";
import { flatJudges } from "@/server/judging/flat";
import {
  averageRanks,
  estimateVariance,
  fitByAlternation,
  fitLeniency,
  normalize,
  type Obs,
} from "@/server/judging/normalize";

// The engine against the planning run's numbers on the real fixture (BUILD-PLAN
// decision 11 oracle, own-ideas/fixture-proof-preview.txt): flat judge jdg_07 left
// out, W = 0.438, β̂² = 0.010, σ̂² = 0.428, k = 42.6, and the engine's top eight.

let h: Handle;
let all: Obs[];
let kept: Obs[];

beforeAll(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: "2026-09-26T12:00:00.000Z" });
  const criteria = rubricOf(h.db, "evt_01");
  const reviews = finishedReviews(h.db, "evt_01", criteria);
  const flat = new Set(flatJudges(reviews).map((f) => f.judgeId));
  all = reviews.map((r) => ({ judgeId: r.judgeId, projectId: r.projectId, y: weightedTotal(criteria, r.values) }));
  kept = all.filter((o) => !flat.has(o.judgeId));
});

afterAll(() => h.sqlite.close());

describe("normalization on the fixture (decision 11 oracle)", () => {
  it("leaves out exactly the flat judge's three reviews", () => {
    expect(all).toHaveLength(126);
    expect(kept).toHaveLength(123);
    expect(new Set(all.filter((o) => !kept.includes(o)).map((o) => o.judgeId))).toEqual(new Set(["jdg_07"]));
  });

  it("estimates W = 0.438, β̂² = 0.010, σ̂² = 0.428 and k = 42.6", () => {
    const v = estimateVariance(kept);
    console.log(`W=${v.W.toFixed(4)} beta2=${v.beta2.toFixed(4)} sigma2=${v.sigma2.toFixed(4)} k=${v.k?.toFixed(2)}`);
    expect(v.W).toBeCloseTo(0.438, 3);
    expect(v.beta2).toBeCloseTo(0.01, 3);
    expect(v.sigma2).toBeCloseTo(0.428, 3);
    expect(v.k).not.toBeNull();
    expect(v.k!).toBeCloseTo(42.6, 1);
  });

  it("ranks the planning run's top eight in the same order", () => {
    const n = normalize(kept);
    const ranks = averageRanks(n.scores);
    const top = [...ranks].sort((a, b) => a[1] - b[1]).slice(0, 8).map(([p]) => p);
    expect(top).toEqual(["prj_34", "prj_11", "prj_10", "prj_25", "prj_37", "prj_16", "prj_33", "prj_21"]);
  });

  it("the direct solve and the alternating updates agree to 1e-11", () => {
    const k = estimateVariance(kept).k!;
    const direct = fitLeniency(kept, k);
    const loop = fitByAlternation(kept, k);
    let worst = 0;
    for (const [p, s] of direct.scores) worst = Math.max(worst, Math.abs(s - loop.scores.get(p)!));
    for (const [j, b] of direct.leniency) worst = Math.max(worst, Math.abs(b - loop.leniency.get(j)!));
    expect(worst).toBeLessThan(1e-11);
  });

  it("with no leniency (k null) every project's score is its plain mean", () => {
    const fit = fitLeniency(kept, null);
    const sums = new Map<string, number[]>();
    for (const o of kept) sums.set(o.projectId, [...(sums.get(o.projectId) ?? []), o.y]);
    for (const [p, ys] of sums) expect(fit.scores.get(p)).toBeCloseTo(ys.reduce((a, b) => a + b, 0) / ys.length, 12);
  });

  it("known-bad: shifting every project's reviews to the next project id breaks the order", () => {
    const ids = [...new Set(kept.map((o) => o.projectId))].sort();
    const shifted = kept.map((o) => ({ ...o, projectId: ids[(ids.indexOf(o.projectId) + 1) % ids.length]! }));
    const ranks = averageRanks(normalize(shifted).scores);
    const top = [...ranks].sort((a, b) => a[1] - b[1]).slice(0, 8).map(([p]) => p);
    expect(top).not.toEqual(["prj_34", "prj_11", "prj_10", "prj_25", "prj_37", "prj_16", "prj_33", "prj_21"]);
  });
});

describe("the engine's self-test (planted leniency)", () => {
  // Two tracks' worth of synthetic reviews on the fixture's own pairs: true quality
  // per project, a planted leniency per judge, a little noise, fixed seed.
  function planted(leniencySd: number, seed: number): { obs: Obs[]; lean: Map<string, number> } {
    let a = seed >>> 0;
    const rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    const quality = new Map<string, number>();
    const lean = new Map<string, number>();
    for (const o of kept) {
      if (!quality.has(o.projectId)) quality.set(o.projectId, 3.5 + 0.6 * normal());
      if (!lean.has(o.judgeId)) lean.set(o.judgeId, leniencySd * normal());
    }
    return {
      obs: kept.map((o) => ({ ...o, y: quality.get(o.projectId)! + lean.get(o.judgeId)! + 0.3 * normal() })),
      lean,
    };
  }

  it("finds planted leniency: β̂² is near the planted variance and the fitted leniencies follow the planted ones", () => {
    const { obs, lean } = planted(0.8, 11);
    const n = normalize(obs);
    console.log(`planted sd 0.8: beta2=${n.beta2.toFixed(3)} k=${n.k?.toFixed(2)}`);
    expect(n.beta2).toBeGreaterThan(0.3);
    const judges = [...lean.keys()];
    const xs = judges.map((j) => lean.get(j)!);
    const ys = judges.map((j) => n.leniency.get(j)!);
    const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
    const my = ys.reduce((s, y) => s + y, 0) / ys.length;
    const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0);
    const r = cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
    expect(r).toBeGreaterThan(0.8);
  });

  it("finds none when none is planted: β̂² stays near zero", () => {
    const { obs } = planted(0, 12);
    const v = estimateVariance(obs);
    console.log(`planted sd 0: beta2=${v.beta2.toFixed(4)}`);
    expect(v.beta2).toBeLessThan(0.00005); // JUDGING.md: "comes out at 0.0000"
  });

  it("a global transform of every score moves every normalized score the same way", () => {
    const k = estimateVariance(kept).k!;
    const base = fitLeniency(kept, k);
    const moved = fitLeniency(
      kept.map((o) => ({ ...o, y: 2 * o.y + 1 })),
      k,
    );
    for (const [p, s] of base.scores) expect(moved.scores.get(p)).toBeCloseTo(2 * s + 1, 9);
  });
});

describe("the signal check (permutation share)", () => {
  it("on the fixture finds no project differences beyond chance: 1,529 of 2,000 shuffles, 0.7645 (the planning run's Python version: 0.767)", async () => {
    const { permutationShare } = await import("@/server/judging/normalize");
    const s = permutationShare(kept);
    console.log(`fixture permutation share ${s.share.toFixed(3)} over ${s.trials} shuffles`);
    expect(s.share).toBe(1529 / 2000); // fixed seed, 2,000 shuffles: the number JUDGING.md states
  });

  it("positive control: planted project differences are detected (share at most 0.05)", async () => {
    const { permutationShare } = await import("@/server/judging/normalize");
    const quality = new Map<string, number>();
    [...new Set(kept.map((o) => o.projectId))].sort().forEach((p, i) => quality.set(p, (i % 7) * 0.35));
    const planted = kept.map((o) => ({ ...o, y: o.y * 0.3 + quality.get(o.projectId)! }));
    expect(permutationShare(planted, 500).share).toBeLessThanOrEqual(0.05);
  });
});
