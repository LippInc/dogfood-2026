import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  COIN_FLIP_Z,
  fitPairwise,
  judgeAgreement,
  MIN_PICKS_FOR_FLAG,
  replayInsertion,
  sigmoid,
  TIE_RATE_FLAG,
  type Comparison,
  type PickRecord,
} from "@/server/judging/pairwise";

// The pairwise proof (JUDGING.md "Pairwise mode"): a Monte Carlo on the fixture's real
// tracks and judge-project pairs, where simulated judges place their assigned projects by
// binary insertion exactly as the Compare screen asks them, with known qualities, their own
// discrimination and known pulls of the left side (h) and of the project just opened (nu).
// Assertions pre-declared 2026-09-27 before the first run (pairwise-2026-09-27/DESIGN.md):
//  (a) with the pulls present, the engine's within-track Kendall tau (tau-b) beats the naive
//      win-rate ranking's; (b) without them it trails nothing by more than the run-to-run sd;
//  (c) the mean estimates of h and nu are within 0.1 of truth; (d) the 95 % intervals of
//      each project's strength relative to its track cover the truth in 90 to 99 % of cases;
//  (e) the coin-flip flag fires on honest judges (6+ picks) in at most 15 % of cases.
// Known-bad: a fit with its project labels shuffled must fail (a).
// Measured 2026-09-27 with gamma under the name tau: (a) held by +0.002 (run-to-run sd 0.044).
// Re-measured 2026-09-29 with tau-b: +0.011 (sd 0.043), mostly because the win rate ties
// projects; JUDGING.md "The proof" gives both and reads it as about a match, not a win.

type Fixture = {
  tracks: { id: string }[];
  judges: { id: string; tracks: string[] }[];
  projects: { id: string; track: string }[];
  scores: { judge: string; project: string }[];
};
const fx = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8")) as Fixture;
const trackOf = new Map(fx.projects.map((p) => [p.id, p.track]));
const TRACKS = fx.tracks.map((t) => ({ trackId: t.id, projectIds: fx.projects.filter((p) => p.track === t.id).map((p) => p.id) }));
// each judge's assigned projects, per track, from the fixture's real pairs
const ASSIGNED = new Map<string, Map<string, string[]>>();
for (const s of fx.scores) {
  const perTrack = ASSIGNED.get(s.judge) ?? new Map<string, string[]>();
  const t = trackOf.get(s.project)!;
  perTrack.set(t, [...(perTrack.get(t) ?? []), s.project]);
  ASSIGNED.set(s.judge, perTrack);
}

function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(r: () => number) {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}
function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type JudgeKind = { tau: number; strategic?: string };
type Scenario = { h: number; nu: number; tau: (r: () => number) => number; coinFlipper?: boolean; strategic?: boolean };

/** One simulated event: every judge places their projects; returns the comparisons and the truth. */
function simulate(seed: number, sc: Scenario) {
  const r = rng(seed);
  const q = new Map(fx.projects.map((p) => [p.id, normal(r)]));
  const judges = [...ASSIGNED.keys()];
  const kinds = new Map<string, JudgeKind>(judges.map((j) => [j, { tau: sc.tau(r) }]));
  const heavy = judges.filter((j) => [...ASSIGNED.get(j)!.values()].some((ps) => ps.length >= 5));
  const flipper = sc.coinFlipper ? heavy[Math.floor(r() * heavy.length)]! : null;
  if (flipper) kinds.set(flipper, { tau: 0 });
  let strategic: { judge: string; favourite: string } | null = null;
  if (sc.strategic) {
    const j = heavy.filter((x) => x !== flipper)[Math.floor(r() * (heavy.length - 1))]!;
    const ps = [...ASSIGNED.get(j)!.values()].find((x) => x.length >= 5)!;
    strategic = { judge: j, favourite: ps[Math.floor(r() * ps.length)]! };
    kinds.set(j, { tau: kinds.get(j)!.tau, strategic: strategic.favourite });
  }
  const comps: Comparison[] = [];
  for (const j of judges) {
    const kind = kinds.get(j)!;
    for (const [trackId, projects] of ASSIGNED.get(j)!) {
      const queue = shuffle(projects, r);
      const picks: PickRecord[] = [];
      for (let guard = 0; guard < 200; guard++) {
        const s = replayInsertion(j, queue, picks);
        if (!s.current) break;
        const { left, right, newId } = s.current;
        const newSign = newId === left ? 1 : -1;
        const p = kind.tau === 0 ? 0.5 : sigmoid(kind.tau * (q.get(left)! - q.get(right)!) + sc.h + sc.nu * newSign);
        let outcome: PickRecord["outcome"] = r() < p ? "left" : "right";
        if (kind.strategic && (left === kind.strategic || right === kind.strategic)) {
          const favLost = (outcome === "left" ? right : left) === kind.strategic;
          if (favLost) outcome = "tie";
        }
        picks.push({ left, right, newId, outcome });
        comps.push({
          judgeId: j,
          trackId,
          a: left,
          b: right,
          y: outcome === "left" ? 1 : outcome === "right" ? 0 : 0.5,
          weight: 1,
          kind: "pick",
          newIs: newId === left ? "a" : "b",
        });
      }
    }
  }
  return { q, comps, flipper, strategic };
}

/**
 * Kendall's tau-b between estimates and truth over the pairs of projects in the same track
 * (every track's pairs pooled): (C - D) / sqrt((n - tied in est) (n - tied in truth)). A pair
 * the estimate ties counts in n, so a ranking that cannot tell two projects apart pays for it;
 * dropping tied pairs instead would be Goodman-Kruskal gamma, which the first version of this
 * test computed under the name tau (2026-09-29, a judge's-eye reading). The same formula as
 * tests/normalization-mc.test.ts and kendallTauB in src/server/dal/results.ts.
 */
function tau(est: Map<string, number>, truth: Map<string, number>, tracks: { projectIds: string[] }[] = TRACKS) {
  let conc = 0;
  let disc = 0;
  let n = 0;
  let tiedEst = 0;
  let tiedTruth = 0;
  for (const t of tracks) {
    const ids = t.projectIds.filter((id) => est.has(id));
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const dx = est.get(ids[i]!)! - est.get(ids[j]!)!;
        const dy = truth.get(ids[i]!)! - truth.get(ids[j]!)!;
        const zx = Math.abs(dx) <= 1e-12;
        const zy = Math.abs(dy) <= 1e-12;
        n++;
        if (zx) tiedEst++;
        if (zy) tiedTruth++;
        if (zx || zy) continue;
        if (dx > 0 === dy > 0) conc++;
        else disc++;
      }
    }
  }
  const den = Math.sqrt((n - tiedEst) * (n - tiedTruth));
  return den > 0 ? (conc - disc) / den : 0;
}

function winRate(comps: Comparison[]) {
  const w = new Map<string, number>();
  const n = new Map<string, number>();
  for (const c of comps) {
    w.set(c.a, (w.get(c.a) ?? 0) + c.y);
    w.set(c.b, (w.get(c.b) ?? 0) + 1 - c.y);
    n.set(c.a, (n.get(c.a) ?? 0) + 1);
    n.set(c.b, (n.get(c.b) ?? 0) + 1);
  }
  return new Map([...n].map(([id, k]) => [id, w.get(id)! / k]));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};
const f3 = (x: number) => x.toFixed(3);
const heterogeneous = (r: () => number) => 1.5 * Math.exp(0.3 * normal(r));

function compare(runs: number, seed0: number, sc: Scenario) {
  const engine: number[] = [];
  const naive: number[] = [];
  const shuffled: number[] = [];
  const hs: number[] = [];
  const nus: number[] = [];
  for (let k = 0; k < runs; k++) {
    const { q, comps } = simulate(seed0 + k, sc);
    const fit = fitPairwise(TRACKS, comps);
    const est = new Map(fit.projects.filter((p) => p.comparisons > 0).map((p) => [p.id, p.s]));
    engine.push(tau(est, q));
    naive.push(tau(winRate(comps), q));
    const ids = [...est.keys()];
    const perm = shuffle(ids, rng(seed0 + k + 7777));
    shuffled.push(tau(new Map(ids.map((id, i) => [perm[i]!, est.get(id)!])), q));
    hs.push(fit.left!.est);
    nus.push(fit.fresh!.est);
  }
  const diff = engine.map((e, i) => e - naive[i]!);
  return { engine, naive, shuffled, hs, nus, diff };
}

describe("pairwise Monte Carlo on the fixture's judges and assignments", () => {
  it("scores with Kendall's tau-b: a tie in the estimate costs it, where gamma would not notice", () => {
    const m = (xs: number[]) => new Map(xs.map((x, i) => [`p${i}`, x]));
    const one = [{ projectIds: ["p0", "p1", "p2"] }];
    expect(tau(m([1, 2, 3]), m([1, 2, 3]), one)).toBe(1);
    expect(tau(m([3, 2, 1]), m([1, 2, 3]), one)).toBe(-1);
    // known-bad for gamma: it drops the tied pair and reads 1
    expect(tau(m([1, 1, 2]), m([1, 2, 3]), one)).toBeCloseTo(2 / Math.sqrt(6), 12);
    expect(tau(m([1, 1, 1]), m([1, 2, 3]), one)).toBe(0);
  });

  it("(a) and (c): with a left pull of 0.3 and a just-opened pull of 0.2, the engine beats the win rate and recovers both pulls; known-bad fails (a)", () => {
    const res = compare(200, 1000, { h: 0.3, nu: 0.2, tau: heterogeneous });
    console.log(
      `pulls present, 200 runs: engine tau ${f3(mean(res.engine))} (sd ${f3(sd(res.engine))}), win rate ${f3(mean(res.naive))} (sd ${f3(sd(res.naive))}), ` +
        `difference ${f3(mean(res.diff))} (sd ${f3(sd(res.diff))}); h ${f3(mean(res.hs))} (true 0.3, sd ${f3(sd(res.hs))}), nu ${f3(mean(res.nus))} (true 0.2, sd ${f3(sd(res.nus))}); shuffled labels ${f3(mean(res.shuffled))}`,
    );
    expect(mean(res.engine)).toBeGreaterThan(mean(res.naive));
    expect(Math.abs(mean(res.hs) - 0.3)).toBeLessThan(0.1);
    expect(Math.abs(mean(res.nus) - 0.2)).toBeLessThan(0.1);
    expect(mean(res.shuffled)).toBeLessThan(mean(res.naive)); // the known-bad would fail (a)
  }, 180_000);

  it("(b): with no pulls, the engine trails the win rate by no more than the run-to-run sd", () => {
    const res = compare(200, 5000, { h: 0, nu: 0, tau: heterogeneous });
    console.log(`no pulls, 200 runs: engine tau ${f3(mean(res.engine))}, win rate ${f3(mean(res.naive))}, difference ${f3(mean(res.diff))} (sd ${f3(sd(res.diff))})`);
    expect(mean(res.diff)).toBeGreaterThan(-sd(res.diff));
    // (b2), added after the third outside reading called (b) loose (its margin is the run-to-run sd,
    // not the error of the mean): at 95 % confidence the engine trails by at most 0.020 tau. The
    // margin was set after this run was seen, so it states the measurement tighter; it was not declared.
    const low = mean(res.diff) - (1.96 * sd(res.diff)) / Math.sqrt(res.diff.length);
    console.log(`(b2) no pulls: mean difference ${f3(mean(res.diff))}, 95 % lower bound ${f3(low)}, over ${res.diff.length} runs`);
    expect(low).toBeGreaterThan(-0.02);
  }, 180_000);

  it("(d): the 95 % intervals of each project's strength against its track's mean cover the truth 90 to 99 % of the time", () => {
    let covered = 0;
    let total = 0;
    const TAU = 1.5;
    for (let k = 0; k < 150; k++) {
      const { q, comps } = simulate(9000 + k, { h: 0.3, nu: 0.2, tau: () => TAU });
      const fit = fitPairwise(TRACKS, comps);
      for (const t of TRACKS) {
        const rows = fit.projects.filter((p) => p.trackId === t.trackId);
        const qbar = mean(rows.map((p) => q.get(p.id)!));
        for (const p of rows) {
          if (p.comparisons === 0) continue;
          // win % is σ(s - mean); its ± comes from Var(s - mean): check the truth on that scale
          const truth = sigmoid(TAU * (q.get(p.id)! - qbar));
          if (Math.abs(truth - p.winPct) <= 1.96 * p.winPctSe) covered++;
          total++;
        }
      }
    }
    console.log(`coverage of 95 % intervals for win %: ${f3(covered / total)} over ${total} project-runs`);
    expect(covered / total).toBeGreaterThanOrEqual(0.9);
    expect(covered / total).toBeLessThanOrEqual(0.99);
  }, 180_000);

  it("(e): the coin-flip flag's rate on honest judges stays at or under 15 %; its power and the strategic judge are reported", () => {
    let honestFlags = 0;
    let honestN = 0;
    let flipperFlags = 0;
    let flipperN = 0;
    let strategicTieFlags = 0;
    const gains: number[] = [];
    for (let k = 0; k < 120; k++) {
      const { comps, flipper, strategic, q } = simulate(20000 + k, { h: 0.3, nu: 0.2, tau: heterogeneous, coinFlipper: true, strategic: true });
      for (const j of ASSIGNED.keys()) {
        const a = judgeAgreement(TRACKS, comps, j);
        // the same rule the data layer applies (computePairwise)
        if (a.picks < MIN_PICKS_FOR_FLAG) continue;
        const flagged = (a.z !== null && a.z < COIN_FLIP_Z) || a.ties / a.picks > TIE_RATE_FLAG;
        if (j === flipper) {
          flipperN++;
          flipperFlags += Number(flagged);
        } else if (j === strategic?.judge) strategicTieFlags += Number(flagged);
        else {
          honestN++;
          honestFlags += Number(flagged);
        }
      }
      if (strategic) {
        // how many places the strategic judge's ties buy the favourite, against an honest answer
        const honest = comps.map((c) => {
          if (c.judgeId !== strategic.judge || c.y !== 0.5) return c;
          return { ...c, y: (q.get(c.a)! > q.get(c.b)! ? 1 : 0) as 0 | 1 };
        });
        const place = (cs: Comparison[]) => fitPairwise(TRACKS, cs).projects.find((p) => p.id === strategic.favourite)!.place;
        gains.push(place(honest) - place(comps));
      }
    }
    console.log(
      `flag (z < ${COIN_FLIP_Z} or ties over ${TIE_RATE_FLAG * 100} %): honest judges ${honestFlags}/${honestN} = ${f3(honestFlags / honestN)}, ` +
        `coin-flipping judge ${flipperFlags}/${flipperN} = ${f3(flipperFlags / Math.max(1, flipperN))}, strategic judge flagged ${strategicTieFlags}/120; ` +
        `places the strategic ties bought the favourite: mean ${f3(mean(gains))}, max ${Math.max(...gains)}`,
    );
    expect(honestN).toBeGreaterThan(100);
    expect(honestFlags / honestN).toBeLessThanOrEqual(0.15);
    // its power, declared with its margin in JUDGING.md: a random judge at least 3 times as often as an honest one (6.2 measured)
    expect(flipperN).toBeGreaterThan(100);
    expect(flipperFlags / flipperN).toBeGreaterThan(3 * (honestFlags / honestN));
  }, 300_000);
});
