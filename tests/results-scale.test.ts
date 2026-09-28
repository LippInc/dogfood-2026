import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { FixtureSchema, importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { requireEvent } from "@/server/dal/events";
import { computeNormalization } from "@/server/dal/normalization";
import { computePairwise } from "@/server/dal/pairwise";
import { getNormalization } from "@/server/dal/results";
import { getEventCards, getOverview } from "@/server/dal/overview";
import { setJudgeOverride } from "@/server/dal/decisions";
import { memoStats } from "@/server/dal/memo";
import type { Actor } from "@/server/authz";

// The organizer's heavy views on a large event. The engines are pure, so each run is kept
// until the data changes (src/server/dal/memo.ts) and each view computes each engine once.
// Checked here: a kept run equals a fresh one, a write is seen at once, a run computed
// inside a transaction that rolls back is not kept, and a second view computes nothing.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

function uniform(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An event in the organizers' fixture format: P projects over 8 tracks, J judges in two tracks each, 3 reviews per project, `flat` judges who give 4 / 4 / 4 everywhere. */
function largeEvent(P: number, J: number, flat: number) {
  const r = uniform(7);
  const T = 8;
  const tracks = Array.from({ length: T }, (_, i) => ({ id: `trk_${i}`, name: `Track ${i}` }));
  const judges = Array.from({ length: J }, (_, i) => ({ id: `jdg_${i}`, name: `Judge ${i}`, email: `j${i}@example.org`, tracks: [`trk_${i % T}`, `trk_${(i + 1) % T}`] }));
  const teams = Array.from({ length: P }, (_, i) => ({ id: `tm_${i}`, name: `Team ${i}`, members: [`m${i}@example.org`] }));
  const projects = Array.from({ length: P }, (_, i) => ({
    id: `prj_${i}`,
    team: `tm_${i}`,
    track: `trk_${i % T}`,
    title: `Project ${i}`,
    summary: "One line.",
    repo_url: `https://example.org/${i}`,
    submitted_at: "2026-02-27T04:08:00Z",
  }));
  const scores: unknown[] = [];
  for (const p of projects) {
    const pool = judges.filter((j) => j.tracks.includes(p.track));
    for (let k = 0; k < 3 && pool.length; k++) {
      const j = pool.splice(Math.floor(r() * pool.length), 1)[0]!;
      const isFlat = Number(j.id.split("_")[1]) < flat;
      const v = () => (isFlat ? 4 : 1 + Math.floor(r() * 5));
      scores.push({ judge: j.id, project: p.id, criteria: { functionality: v(), quality: v(), innovation: v() }, comment: "" });
    }
  }
  return FixtureSchema.parse({ event: { id: "evt_big", name: "Large event", submissions_close: "2026-03-01T18:00:00Z" }, tracks, judges, teams, projects, scores });
}

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  importFixtures(h.db, largeEvent(300, 60, 2), { source: "large.json", sha256: "large", now: NOW });
  ensureDemoOrganizer(h.db, "evt_big", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function organizer(): Actor {
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, "usr_organizer")).all();
  return { userId: "usr_organizer", name: "Organizer", email: "organizer@example.org", isAdmin: false, roles, sessionKind: "login" };
}

/** A fresh run: inside a transaction nothing is kept or reused. */
const fresh = <T,>(fn: () => T): T => {
  let out: T;
  h.db.transaction(() => {
    out = fn();
  });
  return out!;
};

describe("the organizer's views on an event of 300 projects and 60 judges", { timeout: 120_000 }, () => {
  it("a kept run equals a fresh one, for both engines", () => {
    const ev = requireEvent(h.db, "evt_big");
    const kept = computeNormalization(h.db, ev, { signal: true, influence: true });
    expect(computeNormalization(h.db, ev, { signal: true, influence: true })).toBe(kept);
    expect(JSON.stringify(fresh(() => computeNormalization(h.db, ev, { signal: true, influence: true })))).toBe(JSON.stringify(kept));
    const pw = computePairwise(h.db, ev, { scoresOnly: true });
    expect(computePairwise(h.db, ev, { scoresOnly: true })).toBe(pw);
    expect(JSON.stringify(fresh(() => computePairwise(h.db, ev, { scoresOnly: true })).fit)).toBe(JSON.stringify(pw.fit));
  });

  it("a write is seen at once (known-bad: a run kept across an override would still count the judge)", () => {
    const org = organizer();
    const before = getNormalization(org, "evt_big");
    const judge = before.normalization.judges.find((j) => !j.excluded && j.n > 0)!;
    setJudgeOverride(org, "evt_big", { judgeUserId: judge.id, mode: "exclude", reason: "checking that a kept run notices" });
    const after = getNormalization(org, "evt_big");
    expect(after.normalization.excluded).toContain(judge.id);
    expect(before.normalization.excluded).not.toContain(judge.id);
  });

  it("a run computed inside a transaction that rolls back is not kept", () => {
    const org = organizer();
    const ev = requireEvent(h.db, "evt_big");
    const judge = computeNormalization(h.db, ev).judges.find((j) => !j.excluded && j.n > 0)!;
    expect(() =>
      h.db.transaction(() => {
        setJudgeOverride(org, "evt_big", { judgeUserId: judge.id, mode: "exclude", reason: "this never commits" });
        expect(computeNormalization(h.db, ev).excluded).toContain(judge.id);
        throw new Error("roll back");
      }),
    ).toThrow("roll back");
    expect(computeNormalization(h.db, ev).excluded).not.toContain(judge.id);
  });

  it("each view runs each engine once; a second view and the event list reuse them; timings printed", () => {
    const org = organizer();
    const t0 = performance.now();
    const results = getNormalization(org, "evt_big");
    const t1 = performance.now();
    const overview = getOverview(org, "evt_big");
    const t2 = performance.now();
    const computed = memoStats.computed;
    getNormalization(org, "evt_big");
    getOverview(org, "evt_big");
    const [card] = getEventCards(org, ["evt_big"]);
    const t3 = performance.now();
    console.log(
      `300 projects, 60 judges: results view first ${(t1 - t0).toFixed(0)} ms, overview ${(t2 - t1).toFixed(0)} ms; again with the event list ${(t3 - t2).toFixed(0)} ms`,
    );
    // Guarded reads write a refusal row only on refusal; these are allowed, so nothing changed and nothing is recomputed.
    expect(memoStats.computed).toBe(computed);
    expect(card!.pipeline).toEqual(overview.pipeline);
    expect(card!.open).toBe(overview.open);
    expect(results.decisions.filter((d) => d.kind === "flat_judge")).toHaveLength(2);
    expect(t3 - t2).toBeLessThan(5_000);
  });
});

describe("the event list's cards", () => {
  it("say what the overview says on the sample event", () => {
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
    ensureDemoOrganizer(h.db, "evt_01", NOW);
    const org = organizer();
    const [card] = getEventCards(org, ["evt_01"]);
    const o = getOverview(org, "evt_01");
    expect(card!.pipeline).toEqual(o.pipeline);
    expect(card!.open).toBe(o.open);
    expect(card!.open).toBeGreaterThan(0);
    expect(card!.judges).toEqual({ total: o.judges.total, reviewsDone: o.judges.reviewsDone, reviewsAssigned: o.judges.reviewsAssigned });
  });

  it("are refused to someone who does not organize the event", () => {
    const outsider: Actor = { userId: "usr_nobody", name: "Nobody", email: "nobody@example.org", isAdmin: false, roles: [], sessionKind: "login" };
    expect(() => getEventCards(outsider, ["evt_big"])).toThrow();
    expect(getEventCards(organizer(), ["evt_big"])).toHaveLength(1);
  });
});
