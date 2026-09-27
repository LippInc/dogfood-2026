import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { computeNormalization } from "@/server/dal/normalization";
import { requireEvent } from "@/server/dal/events";
import { estimateVariance, fitLeniency, type Obs } from "@/server/judging/normalize";
import { judgeSpread } from "@/server/judging/yardstick";

// The organizers' Normalization Proof yardstick (the spread of per-judge averages), raw and
// after the engine, with the fair-judge baseline. On the sample event the numbers go into
// JUDGING.md; a planted tilt must show up above the baseline and shrink after the engine.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

/** The fixture's reviews as the engine counts them: equal-weight totals, the flat judge left out. */
function fixtureObs(): Obs[] {
  const { fixture } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  return fixture.scores
    .filter((s) => s.judge !== "jdg_07")
    .map((s) => {
      const values = Object.values(s.criteria).filter((v): v is number => typeof v === "number");
      return { judgeId: s.judge, projectId: s.project, y: values.reduce((a, b) => a + b, 0) / values.length };
    });
}

describe("the organizers' yardstick", () => {
  it("on the sample event: 29 counted judges, raw spread 0.416, after the engine 0.398, inside the fair judges' band; the same numbers every time", () => {
    const n = computeNormalization(h.db, requireEvent(h.db, "evt_01"));
    const y = n.yardstick!;
    expect(y.judges).toBe(29);
    expect(y.raw).toBeCloseTo(0.4162, 3);
    expect(y.after).toBeCloseTo(0.3976, 3);
    expect(y.largestLeniency).toBeCloseTo(0.0621, 3);
    expect(y.fair.low).toBeLessThan(y.raw);
    expect(y.fair.high).toBeGreaterThan(y.raw);
    expect(y.fair.atOrAbove).toBeGreaterThan(0.05);
    expect(computeNormalization(h.db, requireEvent(h.db, "evt_01")).yardstick).toEqual(y);
  });

  it("known-bad: with a real tilt planted (three judges +0.6), the raw spread rises above the fair band and the engine takes most of it out", () => {
    const tilted = new Set(["jdg_02", "jdg_12", "jdg_30"]);
    const obs = fixtureObs().map((o) => (tilted.has(o.judgeId) ? { ...o, y: o.y + 0.6 } : o));
    const v = estimateVariance(obs);
    const fit = fitLeniency(obs, v.k);
    const y = judgeSpread(obs, fit.leniency, v.sigma2)!;
    expect(y.raw).toBeGreaterThan(y.fair.high);
    expect(y.fair.atOrAbove).toBeLessThan(0.05);
    expect(y.after).toBeLessThan(y.raw - 0.05);
  });
});
