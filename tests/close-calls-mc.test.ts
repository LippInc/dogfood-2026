import { describe, expect, it } from "vitest";
import { normalize, type Obs } from "@/server/judging/normalize";
import { seededRng } from "@/server/judging/random";
import { closeCall } from "@/server/judging/decision";

// An in-repository check of the close-call rule (JUDGING.md, "Close calls"), smaller than the engine experiment's
// verifier: simulated events run through the real engine (normalize with its ±) and the real rule. With no real
// differences between projects the rule should almost never name a winner; where projects differ, the winners it
// names should almost always be the true best. Known-bads: the same rule fed a halved ± names a winner in 15 % of
// no-signal tracks, and fed a ± of zero in every track, so this instrument can fail.

const TRACKS = 8;
const PER_TRACK = 5;
const JUDGES = 12;
const REVIEWS = 3;
const RUNS = 150;

function gauss(r: () => number) {
  return () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** One event: every project reviewed by REVIEWS distinct judges, each judge with a leniency; `signal` gives projects real differences. */
function simulate(run: number, signal: boolean) {
  const r = seededRng(20260929 + run * 7919);
  const g = gauss(r);
  const projects = Array.from({ length: TRACKS * PER_TRACK }, (_, i) => ({ id: `p${String(i).padStart(2, "0")}`, track: Math.floor(i / PER_TRACK), q: signal ? g() : 0 }));
  const lenient = Array.from({ length: JUDGES }, () => 0.3 * g());
  const obs: Obs[] = [];
  for (const p of projects) {
    const judges = new Set<number>();
    while (judges.size < REVIEWS) judges.add(Math.floor(r() * JUDGES));
    for (const j of judges) obs.push({ judgeId: `j${j}`, projectId: p.id, y: 3 + p.q + lenient[j]! + 0.6 * g() });
  }
  return { projects, fit: normalize(obs, { errors: true }) };
}

function tally(signal: boolean, seScale = 1) {
  let trackRuns = 0;
  let declared = 0;
  let right = 0;
  for (let run = 0; run < RUNS; run++) {
    const { projects, fit } = simulate(run, signal);
    for (let t = 0; t < TRACKS; t++) {
      const rows = projects.filter((p) => p.track === t);
      const cc = closeCall(rows.map((p) => ({ id: p.id, score: fit.scores.get(p.id)!, se: (fit.se?.scores.get(p.id) ?? null) === null ? null : fit.se!.scores.get(p.id)! * seScale })));
      if (!cc) continue;
      trackRuns++;
      if (!cc.callable) continue;
      declared++;
      const best = rows.reduce((b, p) => (p.q > b.q ? p : b), rows[0]!);
      if (cc.top[0] === best.id) right++;
    }
  }
  return { trackRuns, declared, right };
}

describe("the close-call rule on simulated events", () => {
  it("with no real differences it almost never names a winner", () => {
    const none = tally(false);
    expect(none.trackRuns).toBe(RUNS * TRACKS); // every track was checked (guard against an empty count)
    expect(none.declared / none.trackRuns).toBeLessThan(0.01);
  });

  it("where projects differ it names winners, and they are almost always the true best", () => {
    const some = tally(true);
    expect(some.declared).toBeGreaterThan(0.1 * some.trackRuns);
    expect(some.right / some.declared).toBeGreaterThanOrEqual(0.95);
  });

  it("known-bads: an overconfident ± (halved) fails the no-signal line, and a ± of zero names a winner in every track", () => {
    // measured when written: no signal 6 of 1,200 track-runs (0.5 %); with the ± halved 182 of 1,200 (15 %)
    const halved = tally(false, 0.5);
    expect(halved.declared / halved.trackRuns).toBeGreaterThan(0.01);
    const blind = tally(false, 0);
    expect(blind.declared).toBe(blind.trackRuns);
  });
});
