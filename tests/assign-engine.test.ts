import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assignJudges, type AssignInput, type AssignResult } from "@/server/judging/assign";

// Pure: the engine input is built from the real fixture's shape, no database.

type FixtureJson = {
  judges: { id: string; tracks: string[] }[];
  projects: { id: string; track: string }[];
};

const fixture: FixtureJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8"));

const trackOf = new Map(fixture.projects.map((p) => [p.id, p.track]));
const tracksOf = new Map(fixture.judges.map((j) => [j.id, j.tracks]));

const baseInput = (): AssignInput => ({
  mode: "fresh",
  seed: 42,
  reviewsPerProject: 3,
  bridgePerTrack: 2,
  maxPerJudge: null,
  projects: fixture.projects.map((p) => ({ id: p.id, trackId: p.track })),
  judges: fixture.judges.map((j) => ({ id: j.id, trackIds: j.tracks })),
  conflicts: [],
  existing: [],
  excludedJudges: [],
});

const pairKeys = (r: AssignResult) => r.pairs.map((p) => `${p.judgeId}|${p.projectId}`).sort();

describe("assignJudges (pure, fixture-shaped input)", () => {
  it("runs on the fixture this file assumes", () => {
    expect(fixture.judges).toHaveLength(30);
    expect(fixture.projects).toHaveLength(41);
    expect(fixture.judges.filter((j) => j.tracks.length === 2)).toHaveLength(9);
    expect(tracksOf.get("jdg_24")).toEqual(["trk_01", "trk_07"]);
  });

  it("is deterministic: the same input and seed give the same whole result twice", () => {
    expect(assignJudges(baseInput())).toEqual(assignJudges(baseInput()));
  });

  it("known-bad: a different seed changes the pairs, so the seed is really used", () => {
    const a = assignJudges(baseInput());
    const b = assignJudges({ ...baseInput(), seed: 43 });
    expect(a.pairs.length).toBeGreaterThan(0);
    expect(pairKeys(a)).not.toEqual(pairKeys(b));
  });

  it("input order does not matter: reversed projects and judges give the same pairs", () => {
    const a = baseInput();
    const reversed: AssignInput = {
      ...a,
      projects: [...a.projects].reverse(),
      judges: [...a.judges].reverse(),
    };
    expect(pairKeys(assignJudges(reversed))).toEqual(pairKeys(assignJudges(baseInput())));
  });

  it("assigns only in-track pairs, and no (judge, project) pair twice", () => {
    const r = assignJudges(baseInput());
    expect(r.pairs.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const p of r.pairs) {
      expect(tracksOf.get(p.judgeId), `${p.judgeId}'s tracks`).toContain(trackOf.get(p.projectId));
      const key = `${p.judgeId}|${p.projectId}`;
      expect(seen.has(key), `duplicate pair ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("gives every project exactly min(3, eligible judges in its track) reviews", () => {
    const r = assignJudges(baseInput());
    const judgesPerTrack = new Map<string, number>();
    for (const j of fixture.judges) {
      for (const t of j.tracks) judgesPerTrack.set(t, (judgesPerTrack.get(t) ?? 0) + 1);
    }
    const reviews = new Map<string, number>();
    for (const p of r.pairs) reviews.set(p.projectId, (reviews.get(p.projectId) ?? 0) + 1);
    for (const p of fixture.projects) {
      expect(reviews.get(p.id) ?? 0, `${p.id} (${p.track})`).toBe(Math.min(3, judgesPerTrack.get(p.track)!));
    }
  });

  it("bridges: every two-track judge ends with at least 2 projects in each of its tracks", () => {
    const r = assignJudges(baseInput());
    const twoTrack = fixture.judges.filter((j) => j.tracks.length === 2);
    for (const j of twoTrack) {
      for (const t of j.tracks) {
        const got = r.pairs.filter((p) => p.judgeId === j.id && trackOf.get(p.projectId) === t).length;
        expect(got, `${j.id} in ${t}`).toBeGreaterThanOrEqual(2);
        expect(r.bridge).toContainEqual({ judgeId: j.id, trackId: t, got: 2, wanted: 2 });
      }
    }
  });

  it("known-bad: bridgePerTrack 0 skips the bridge pre-pass entirely", () => {
    const r = assignJudges({ ...baseInput(), bridgePerTrack: 0 });
    expect(r.bridge).toEqual([]);
    // the greedy pass still does the work
    expect(r.pairs.length).toBeGreaterThan(0);
  });

  it("order lists exactly each judge's new projects, each once", () => {
    const r = assignJudges(baseInput());
    for (const [judgeId, list] of Object.entries(r.order)) {
      const fromPairs = r.pairs.filter((p) => p.judgeId === judgeId).map((p) => p.projectId);
      expect([...list].sort()).toEqual([...fromPairs].sort());
      expect(new Set(list).size).toBe(list.length);
    }
    for (const j of fixture.judges) {
      if (r.pairs.some((p) => p.judgeId === j.id)) expect(r.order[j.id]).toBeDefined();
    }
  });

  it("never assigns a conflicted pair", () => {
    const j24 = tracksOf.get("jdg_24")!;
    const target = fixture.projects.find((p) => j24.includes(p.track))!;
    expect(target).toBeDefined();
    const r = assignJudges({ ...baseInput(), conflicts: [{ judgeId: "jdg_24", projectId: target.id }] });
    expect(r.pairs.some((p) => p.judgeId === "jdg_24" && p.projectId === target.id)).toBe(false);
    expect(r.order["jdg_24"] ?? []).not.toContain(target.id);
  });

  it("leaves an excluded judge with no pairs and no key in loads", () => {
    const r = assignJudges({ ...baseInput(), excludedJudges: ["jdg_07"] });
    expect(r.pairs.some((p) => p.judgeId === "jdg_07")).toBe(false);
    expect(r.loads).not.toHaveProperty("jdg_07");
    expect(r.order["jdg_07"]).toBeUndefined();
  });

  it("caps judges at maxPerJudge and leaves the unfilled seats short", () => {
    const r = assignJudges({ ...baseInput(), maxPerJudge: 2 });
    expect(r.pairs.length).toBeGreaterThan(0);
    expect(Object.values(r.loads).every((l) => l <= 2)).toBe(true);
    const newPairs = new Map<string, number>();
    for (const p of r.pairs) newPairs.set(p.judgeId, (newPairs.get(p.judgeId) ?? 0) + 1);
    expect(Math.max(...newPairs.values())).toBeLessThanOrEqual(2);
    expect(r.short.length).toBeGreaterThan(0);
    expect(r.short.every((s) => s.reviews < s.target)).toBe(true);
  });

  it("flags a project whose track only one judge covers, and never crosses tracks to fill it", () => {
    const input: AssignInput = {
      mode: "fresh",
      seed: 7,
      reviewsPerProject: 3,
      bridgePerTrack: 2,
      maxPerJudge: null,
      projects: [
        { id: "pX", trackId: "trk_x" },
        { id: "pY1", trackId: "trk_y" },
        { id: "pY2", trackId: "trk_y" },
        { id: "pY3", trackId: "trk_y" },
      ],
      judges: [
        { id: "jA", trackIds: ["trk_x"] },
        { id: "jB", trackIds: ["trk_y"] },
        { id: "jC", trackIds: ["trk_y"] },
        { id: "jD", trackIds: ["trk_y"] },
      ],
      conflicts: [],
      existing: [],
      excludedJudges: [],
    };
    const r = assignJudges(input);
    expect(r.underReviewed).toEqual([{ projectId: "pX", eligible: 1 }]);
    const xPairs = r.pairs.filter((p) => p.projectId === "pX");
    expect(xPairs.map((p) => p.judgeId)).toEqual(["jA"]);
    const tracks = new Map(input.judges.map((j) => [j.id, j.trackIds]));
    const projectById = new Map(input.projects.map((p) => [p.id, p]));
    for (const p of r.pairs) {
      expect(tracks.get(p.judgeId)).toContain(projectById.get(p.projectId)!.trackId);
    }
  });

  describe("top-up mode", () => {
    const fresh = assignJudges(baseInput());
    const existing = fresh.pairs.map((p) => ({ judgeId: p.judgeId, projectId: p.projectId, counts: true }));
    const P = [...new Set(existing.map((e) => e.projectId))].sort()[0]!;
    const pExisting = existing.filter((e) => e.projectId === P);

    it("adds nothing when every seat is already filled and counts", () => {
      expect(assignJudges({ ...baseInput(), mode: "topup", existing }).pairs).toEqual([]);
    });

    it("fills exactly the one dropped seat, from a judge who does not already have the project", () => {
      const dropped = pExisting[0]!;
      const kept = existing.filter((e) => !(e.projectId === P && e.judgeId === dropped.judgeId));
      const r = assignJudges({ ...baseInput(), mode: "topup", existing: kept });
      expect(r.pairs).toHaveLength(1);
      expect(r.pairs[0]!.projectId).toBe(P);
      const holders = new Set(kept.filter((e) => e.projectId === P).map((e) => e.judgeId));
      expect(holders.has(r.pairs[0]!.judgeId)).toBe(false);
    });

    it("treats counts: false pairs as seats that still need filling", () => {
      const marked = existing.map((e) => (e.projectId === P ? { ...e, counts: false } : e));
      const r = assignJudges({ ...baseInput(), mode: "topup", existing: marked });
      const newForP = r.pairs.filter((p) => p.projectId === P);
      expect(newForP.length).toBeGreaterThan(0);
      // only P still had open seats
      expect(r.pairs.every((p) => p.projectId === P)).toBe(true);
      const holders = new Set(pExisting.map((e) => e.judgeId));
      for (const p of newForP) expect(holders.has(p.judgeId)).toBe(false);
      const shortP = r.short.find((s) => s.projectId === P);
      if (newForP.length < 3) {
        expect(shortP).toBeDefined();
        expect(shortP!.reviews).toBe(newForP.length);
      } else {
        expect(shortP).toBeUndefined();
      }
    });
  });
});
