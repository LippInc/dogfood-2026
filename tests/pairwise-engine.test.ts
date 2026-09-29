import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fitPairwise,
  impliedFromScores,
  judgeAgreement,
  newOnLeft,
  replayInsertion,
  sigmoid,
  type Comparison,
  type PairwiseFit,
  type PickRecord,
} from "@/server/judging/pairwise";
import { fitPairwiseDense } from "./support/pairwise-dense";

// The pairwise engine's own checks (JUDGING.md "Pairwise mode"). The Monte Carlo on
// the fixture's real judge-project pairs is tests/pairwise-mc.test.ts.

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const TRACK = "trk";
const one = (ids: string[]) => [{ trackId: TRACK, projectIds: ids }];
const pick = (a: string, b: string, y: 1 | 0.5 | 0, judgeId = "j1", newIs: "a" | "b" | null = null): Comparison => ({
  judgeId,
  trackId: TRACK,
  a,
  b,
  y,
  weight: 1,
  kind: "pick",
  newIs,
});

/** Comparisons drawn from a known model: every pair `reps` times, random sides and "new" side. */
function simulate(truth: Record<string, number>, reps: number, h: number, nu: number, seed: number): Comparison[] {
  const r = rng(seed);
  const ids = Object.keys(truth);
  const out: Comparison[] = [];
  for (let n = 0; n < reps; n++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const [left, right] = r() < 0.5 ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
        const newIs = r() < 0.5 ? ("a" as const) : ("b" as const);
        const x = truth[left]! - truth[right]! + h + nu * (newIs === "a" ? 1 : -1);
        out.push(pick(left, right, r() < sigmoid(x) ? 1 : 0, `j${n % 7}`, newIs));
      }
    }
  }
  return out;
}

const byId = (fit: ReturnType<typeof fitPairwise>) => new Map(fit.projects.map((p) => [p.id, p]));

describe("the Bradley-Terry fit", () => {
  const truth = { p1: 1.5, p2: 0.8, p3: 0.2, p4: -0.3, p5: -0.9, p6: -1.3 };

  it("recovers planted strengths and orders the track the same way", () => {
    const fit = fitPairwise(one(Object.keys(truth)), simulate(truth, 60, 0, 0, 1));
    expect(fit.converged).toBe(true);
    const got = byId(fit);
    expect(fit.projects.map((p) => p.id)).toEqual(Object.keys(truth));
    const meanTruth = Object.values(truth).reduce((a, b) => a + b, 0) / 6;
    const meanFit = fit.projects.reduce((a, p) => a + p.s, 0) / 6;
    for (const [id, s] of Object.entries(truth)) expect(Math.abs(got.get(id)!.s - meanFit - (s - meanTruth))).toBeLessThan(0.3);
  });

  it("recovers a planted pull of the left side and of the project just opened, and reports them", () => {
    const fit = fitPairwise(one(Object.keys(truth)), simulate(truth, 120, 0.6, -0.4, 2));
    expect(Math.abs(fit.left!.est - 0.6)).toBeLessThan(0.15);
    expect(Math.abs(fit.fresh!.est + 0.4)).toBeLessThan(0.15);
    expect(fit.left!.se).toBeLessThan(0.1);
  });

  it("known-bad: dropping the side from the model leaves the left pull unmeasured", () => {
    const asScores = simulate(truth, 120, 0.6, 0, 3).map((c) => ({ ...c, kind: "scores" as const, newIs: null }));
    expect(fitPairwise(one(Object.keys(truth)), asScores).left).toBeNull();
  });

  it("keeps a project that won every comparison finite", () => {
    const comps = ["b", "c", "d"].flatMap((o) => Array.from({ length: 10 }, () => pick("a", o, 1)));
    const fit = fitPairwise(one(["a", "b", "c", "d"]), comps);
    expect(fit.converged).toBe(true);
    const a = byId(fit).get("a")!;
    expect(Number.isFinite(a.s) && a.s < 10).toBe(true);
    expect(a.place).toBe(1);
  });

  it("gives equal strengths when every answer is too close to call", () => {
    const comps = [pick("a", "b", 0.5), pick("b", "c", 0.5), pick("a", "c", 0.5)];
    const fit = fitPairwise(one(["a", "b", "c"]), comps);
    const s = fit.projects.map((p) => p.s);
    expect(Math.max(...s) - Math.min(...s)).toBeLessThan(1e-9);
    for (const p of fit.projects) expect(p.winPct).toBeCloseTo(0.5, 9);
  });

  it("does not care which side a pair is written on: swapping sides and outcomes leaves strengths alone and flips the left pull", () => {
    const comps = simulate(truth, 30, 0.5, 0.3, 4);
    const mirrored = comps.map((c) => ({ ...c, a: c.b, b: c.a, y: (1 - c.y) as 1 | 0.5 | 0, newIs: c.newIs === "a" ? ("b" as const) : c.newIs === "b" ? ("a" as const) : null }));
    const f1 = byId(fitPairwise(one(Object.keys(truth)), comps));
    const fit2 = fitPairwise(one(Object.keys(truth)), mirrored);
    const f2 = byId(fit2);
    // Mirroring swaps which project was on the left, so h's sign flips; strengths do not move.
    const fit1 = fitPairwise(one(Object.keys(truth)), comps);
    expect(fit2.left!.est).toBeCloseTo(-fit1.left!.est, 8);
    for (const id of Object.keys(truth)) expect(f2.get(id)!.s).toBeCloseTo(f1.get(id)!.s, 8);
  });

  it("finds a track split into groups never compared across, ranks unknowns last and gives each place its chance to beat the next", () => {
    const comps = [...Array.from({ length: 8 }, () => pick("a", "b", 1)), ...Array.from({ length: 8 }, () => pick("c", "d", 1))];
    const fit = fitPairwise(one(["a", "b", "c", "d", "e"]), comps);
    expect(fit.tracks).toEqual([{ trackId: TRACK, groups: 2 }]);
    const got = byId(fit);
    expect(got.get("a")!.group).toBe(got.get("b")!.group);
    expect(got.get("a")!.group).not.toBe(got.get("c")!.group);
    expect(got.get("e")!).toMatchObject({ comparisons: 0, group: -1, place: 5, beatsNext: null });
    // Places next to each other but in groups never compared: no chance is claimed.
    const ordered = fit.projects.filter((p) => p.comparisons > 0);
    for (let k = 0; k + 1 < ordered.length; k++) {
      const same = ordered[k]!.group === ordered[k + 1]!.group;
      expect(ordered[k]!.beatsNext === null).toBe(!same);
    }
    const strong = fitPairwise(one(["a", "b"]), Array.from({ length: 40 }, () => pick("a", "b", 1)));
    expect(byId(strong).get("a")!.beatsNext!).toBeGreaterThan(0.95);
    const even = fitPairwise(one(["a", "b"]), [pick("a", "b", 1), pick("a", "b", 0)]);
    expect(Math.abs(byId(even).get(even.projects[0]!.id)!.beatsNext! - 0.5)).toBeLessThan(0.01);
  });
});

describe("scores as a judge's order", () => {
  it("turns one judge's k reviews in a track into C(k,2) pairs weighing k - 1 together; equal totals tie; pairs the judge's picks cover drop out", () => {
    const reviews = [
      { judgeId: "j1", trackId: "t", projectId: "a", total: 4 },
      { judgeId: "j1", trackId: "t", projectId: "b", total: 3 },
      { judgeId: "j1", trackId: "t", projectId: "c", total: 3 },
      { judgeId: "j1", trackId: "t", projectId: "d", total: 1 },
      { judgeId: "j2", trackId: "t", projectId: "a", total: 2 },
    ];
    const pairs = impliedFromScores(reviews);
    expect(pairs).toHaveLength(6);
    expect(pairs.reduce((a, c) => a + c.weight, 0)).toBeCloseTo(3, 12);
    expect(pairs.find((c) => c.a === "b" && c.b === "c")!.y).toBe(0.5);
    expect(pairs.find((c) => c.a === "a" && c.b === "d")!.y).toBe(1);
    expect(impliedFromScores(reviews, new Map([["j1|t", new Set(["a", "b", "c", "d"])]]))).toHaveLength(0);
    const partly = impliedFromScores(reviews, new Map([["j1|t", new Set(["a", "b"])]]));
    expect(partly).toHaveLength(5);
    expect(partly.some((c) => c.a === "a" && c.b === "b")).toBe(false);
  });
});

describe("binary insertion", () => {
  /** Answer every question from a true order until the judge's list is complete. */
  function run(truthOrder: string[], queue: string[], judgeId = "j1") {
    const rank = new Map(truthOrder.map((id, i) => [id, i]));
    const picks: PickRecord[] = [];
    for (let guard = 0; guard < 100; guard++) {
      const s = replayInsertion(judgeId, queue, picks);
      if (!s.current) return { state: s, picks };
      const q = s.current;
      picks.push({ left: q.left, right: q.right, newId: q.newId, outcome: rank.get(q.left)! < rank.get(q.right)! ? "left" : "right" });
    }
    throw new Error("insertion did not finish");
  }

  it("places every project in the true order with at most ceil(log2) questions per project", () => {
    const truthOrder = ["d", "b", "f", "a", "e", "c"];
    const { state, picks } = run(truthOrder, ["a", "b", "c", "d", "e", "f"]);
    expect(state.list).toEqual(truthOrder);
    expect(state).toMatchObject({ placed: 6, total: 6, current: null, ignored: 0 });
    expect(picks.length).toBeLessThanOrEqual(0 + 1 + 2 + 2 + 3 + 3);
  });

  it("asks nothing for a single project and starts with the first two", () => {
    expect(replayInsertion("j1", ["a"], [])).toMatchObject({ list: ["a"], current: null, placed: 1 });
    const s = replayInsertion("j1", ["a", "b"], []);
    expect(s.list).toEqual(["a"]);
    expect(s.current!.newId).toBe("b");
    expect(new Set([s.current!.left, s.current!.right])).toEqual(new Set(["a", "b"]));
  });

  it("puts a tied project right below the one it tied with", () => {
    const q = replayInsertion("j1", ["a", "b"], []).current!;
    const s = replayInsertion("j1", ["a", "b"], [{ left: q.left, right: q.right, newId: "b", outcome: "tie" }]);
    expect(s.list).toEqual(["a", "b"]);
  });

  it("ignores a pick that is not the question asked, and one about a project no longer assigned; undo is dropping the last pick", () => {
    const q = replayInsertion("j1", ["a", "b", "c"], []).current!;
    const first: PickRecord = { left: q.left, right: q.right, newId: q.newId, outcome: "left" };
    const s1 = replayInsertion("j1", ["a", "b", "c"], [first]);
    const q2 = s1.current!;
    // the right project, asked against the wrong one of the list (not the middle of its range)
    const offMiddle = s1.list.find((id) => id !== q2.against)!;
    const wrong: PickRecord = { left: q2.newId, right: offMiddle, newId: q2.newId, outcome: "left" };
    expect(replayInsertion("j1", ["a", "b", "c"], [first, wrong])).toMatchObject({ ignored: 1, placed: 2, current: q2 });
    const gone: PickRecord = { left: "x", right: "a", newId: "x", outcome: "left" };
    expect(replayInsertion("j1", ["a", "b", "c"], [gone]).ignored).toBe(1);
    const answered: PickRecord = { left: q.left, right: q.right, newId: q.newId, outcome: "left" };
    const after = replayInsertion("j1", ["a", "b", "c"], [answered]);
    expect(after.placed).toBe(2);
    expect(replayInsertion("j1", ["a", "b", "c"], [answered].slice(0, 0)).current).toEqual(q);
  });

  it("counts an answer to the same question shown the other way round, reading its winner by the sides it was shown with", () => {
    // answers stored under an earlier side rule: every question's sides and its answer mirrored
    const truthOrder = ["d", "b", "f", "a", "e", "c"];
    const queue = ["a", "b", "c", "d", "e", "f"];
    const { picks } = run(truthOrder, queue);
    const flip = { left: "right", right: "left", tie: "tie" } as const;
    const mirrored = picks.map((p) => ({ left: p.right, right: p.left, newId: p.newId, outcome: flip[p.outcome] }));
    expect(replayInsertion("j1", queue, mirrored)).toMatchObject({ list: truthOrder, placed: 6, current: null, ignored: 0 });
    // a mirrored answer read by the question's sides instead would place the new project on the wrong side
    const q = replayInsertion("j1", ["a", "b"], []).current!;
    const newWins: PickRecord = { left: q.right, right: q.left, newId: q.newId, outcome: q.right === q.newId ? "left" : "right" };
    expect(replayInsertion("j1", ["a", "b"], [newWins]).list).toEqual([q.newId, q.against]);
  });

  it("does not stay stuck on a project whose pick no longer fits: the judge's later answers still count", () => {
    const queue = ["a", "b", "c", "d"];
    const q1 = replayInsertion("j1", queue, []).current!;
    const p1: PickRecord = { left: q1.left, right: q1.right, newId: q1.newId, outcome: q1.left === q1.newId ? "left" : "right" };
    const s1 = replayInsertion("j1", queue, [p1]);
    expect(s1.list).toEqual(["b", "a"]);
    // c was asked about against x, which has since left the list; then d was asked about and answered as it is asked today.
    const stale: PickRecord = { left: "c", right: "x", newId: "c", outcome: "left" };
    const against = s1.list[1]!;
    const dLeft = newOnLeft("j1", "d", against);
    const p3: PickRecord = { left: dLeft ? "d" : against, right: dLeft ? against : "d", newId: "d", outcome: dLeft ? "right" : "left" };
    const s = replayInsertion("j1", queue, [p1, stale, p3]);
    expect(s.ignored).toBe(1);
    expect(s.list).toEqual(["b", "a", "d"]);
    expect(s.current!.newId).toBe("c");
  });

  it("gives each question stable sides, about half of them with the new project on the left", () => {
    expect(newOnLeft("j1", "a", "b")).toBe(newOnLeft("j1", "a", "b"));
    let left = 0;
    for (let i = 0; i < 1000; i++) if (newOnLeft(`judge${i % 17}`, `prj_${i}`, `prj_${i + 1}`)) left++;
    expect(left).toBeGreaterThan(400);
    expect(left).toBeLessThan(600);
  });

  it("draws each question's side from a seeded coin, not a bit per id: on the fixture's ids, balanced and independent across judges and pairs", () => {
    const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8")) as { judges: { id: string }[]; projects: { id: string }[] };
    const judges = fx.judges.map((j) => j.id);
    const projects = fx.projects.map((p) => p.id);
    const bit = (j: string, a: string, b: string) => Number(newOnLeft(j, a, b));
    let left = 0;
    let n = 0;
    // A side that is an XOR of one bit per id (the parity of the hash's lowest bit) makes all
    // three of these always 0; a coin makes each 1 about half the time.
    let quad = 0;
    let crossJudge = 0;
    let swapped = 0;
    let m = 0;
    for (const j of judges) {
      for (let i = 0; i + 3 < projects.length; i++) {
        const [a, b, c, d] = [projects[i]!, projects[i + 1]!, projects[i + 2]!, projects[i + 3]!];
        left += bit(j, a, b);
        n++;
        quad += bit(j, a, c) ^ bit(j, a, d) ^ bit(j, b, c) ^ bit(j, b, d);
        swapped += bit(j, a, b) ^ bit(j, b, a) ^ 1; // 1 when the pair asked the other way round keeps the new project on the same side
        const k = judges[(judges.indexOf(j) + 1) % judges.length]!;
        crossJudge += bit(j, a, b) ^ bit(k, a, b) ^ bit(j, c, d) ^ bit(k, c, d);
        m++;
      }
    }
    for (const [count, of] of [
      [left, n],
      [quad, m],
      [swapped, m],
      [crossJudge, m],
    ] as const) {
      expect(count / of).toBeGreaterThan(0.4);
      expect(count / of).toBeLessThan(0.6);
    }
  });
});

describe("a judge's agreement with the rest of the panel", () => {
  const truth = { p1: 2, p2: 1, p3: 0, p4: -1, p5: -2 };
  const ids = Object.keys(truth);
  const panel = simulate(truth, 20, 0, 0, 9).map((c) => ({ ...c, judgeId: "panel" }));
  const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => [a, b] as const));

  it("is high for a judge who follows the panel, low for one who answers the opposite, not given for all ties or under 6 picks", () => {
    const honest = pairs.map(([a, b]) => pick(a, b, 1, "honest"));
    const contrary = pairs.map(([a, b]) => pick(a, b, 0, "contrary"));
    const tier = pairs.map(([a, b]) => pick(a, b, 0.5, "tier"));
    const all = [...panel, ...honest, ...contrary, ...tier];
    const tr = one(ids);
    expect(judgeAgreement(tr, all, "honest").z!).toBeGreaterThan(1.5);
    expect(judgeAgreement(tr, all, "contrary").z!).toBeLessThan(-1.5);
    // All ties: no answer that could agree or disagree, so no z; the tie rule (ties over half) flags such a judge instead.
    expect(judgeAgreement(tr, all, "tier")).toMatchObject({ ties: 10, z: null });
    expect(judgeAgreement(tr, [...panel, ...honest.slice(0, 5)], "honest").z).toBeNull();
  });

  it("scores an answer as agreeing exactly when it names the project the rest of the panel favours, whichever side it was on", () => {
    const tr = one(ids);
    // The same verdicts asked with the sides swapped: "b vs a, right wins" names a, as "a vs b, left wins" does.
    const swapped = pairs.map(([a, b]) => pick(b, a, 0, "swapped"));
    const against = pairs.map(([a, b]) => pick(b, a, 1, "against"));
    const all = [...panel, ...swapped, ...against];
    expect(judgeAgreement(tr, all, "swapped").share).toBe(1);
    expect(judgeAgreement(tr, all, "against").share).toBe(0);
    const honest = pairs.map(([a, b]) => pick(a, b, 1, "honest"));
    const contrary = pairs.map(([a, b]) => pick(a, b, 0, "contrary"));
    expect(judgeAgreement(tr, [...panel, ...honest], "honest").share).toBe(1);
    expect(judgeAgreement(tr, [...panel, ...contrary], "contrary").share).toBe(0);
  });
});

describe("the per-track solve", () => {
  /** A multi-track event: picks with and without a just-opened side, ties, pairs from scores, a one-project track and projects never compared. */
  function design(seed: number, sizes: number[], withPicks: boolean): { tracks: { trackId: string; projectIds: string[] }[]; comps: Comparison[] } {
    const r = rng(seed);
    const tracks = sizes.map((m, t) => ({ trackId: `t${t}`, projectIds: Array.from({ length: m }, (_, i) => `t${t}p${i}`) }));
    const comps: Comparison[] = [];
    for (const t of tracks) {
      const ids = t.projectIds;
      if (ids.length < 2) continue;
      // leave the last project of each track uncompared
      const live = ids.slice(0, -1);
      for (let k = 0; k < live.length * 4; k++) {
        const a = live[Math.floor(r() * live.length)]!;
        const b = live[Math.floor(r() * live.length)]!;
        if (a === b) continue;
        const u = r();
        const y = (u < 0.15 ? 0.5 : u < 0.6 ? 1 : 0) as 1 | 0.5 | 0;
        const isPick = withPicks && r() < 0.6;
        const side = r();
        comps.push({
          judgeId: `j${k % 5}`,
          trackId: t.trackId,
          a,
          b,
          y,
          weight: isPick ? 1 : 2 / 4,
          kind: isPick ? "pick" : "scores",
          newIs: isPick ? (side < 0.4 ? "a" : side < 0.8 ? "b" : null) : null,
        });
      }
    }
    return { tracks, comps };
  }

  const worst = (x: PairwiseFit, y: PairwiseFit) => {
    let d = 0;
    expect(x.projects.map((p) => p.id)).toEqual(y.projects.map((p) => p.id));
    x.projects.forEach((p, i) => {
      const q = y.projects[i]!;
      expect([p.place, p.group, p.comparisons, p.picks, p.beatsNext === null]).toEqual([q.place, q.group, q.comparisons, q.picks, q.beatsNext === null]);
      d = Math.max(d, Math.abs(p.s - q.s), Math.abs(p.se - q.se), Math.abs(p.winPct - q.winPct), Math.abs(p.winPctSe - q.winPctSe), Math.abs((p.beatsNext ?? 0) - (q.beatsNext ?? 0)));
    });
    for (const k of ["left", "fresh"] as const) {
      expect(x[k] === null).toBe(y[k] === null);
      if (x[k] && y[k]) d = Math.max(d, Math.abs(x[k]!.est - y[k]!.est), Math.abs(x[k]!.se - y[k]!.se));
    }
    expect(x.converged).toBe(y.converged);
    return d;
  };

  it("gives what one dense solve of the whole matrix gives: strengths, ±, win %, next-place chances and both pulls", () => {
    for (const seed of [1, 2, 3, 4]) {
      for (const withPicks of [true, false]) {
        const { tracks, comps } = design(seed, [1, 6, 11, 4], withPicks);
        expect(worst(fitPairwise(tracks, comps), fitPairwiseDense(tracks, comps))).toBeLessThan(1e-9);
      }
    }
  });

  it("known-bad: one comparison weighted a little differently on one side breaks the agreement", () => {
    const { tracks, comps } = design(5, [6, 8], true);
    const nudged = comps.map((c, i) => (i === 0 ? { ...c, weight: c.weight * 1.01 } : c));
    expect(worst(fitPairwise(tracks, nudged), fitPairwiseDense(tracks, comps))).toBeGreaterThan(1e-6);
  });

  it("fits an event of 1,000 projects in 8 tracks in well under the dense solve's time", () => {
    const { tracks, comps } = design(20260929, Array.from({ length: 8 }, () => 125), true);
    const t0 = performance.now();
    const fast = fitPairwise(tracks, comps);
    const t1 = performance.now();
    console.log(`1,000 projects in 8 tracks, ${comps.length} comparisons: the per-track solve ${(t1 - t0).toFixed(0)} ms, ${fast.iterations} steps`);
    expect(fast.converged).toBe(true);
    expect(t1 - t0).toBeLessThan(3_000);
  });
});
