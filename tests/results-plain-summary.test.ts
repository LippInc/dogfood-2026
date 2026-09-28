import { describe, expect, it } from "vitest";
import { plainSummary } from "@/app/organize/[event]/results/plain-summary";
import type { JudgeStanding, Normalized, ProjectRow } from "@/server/dal";

// A results-day organizer met k, β̂² and a permutation share before any plain sentence (round-3 tester).
// plainSummary says what the run shows in words, one point each, above the statistics.

function row(o: Partial<ProjectRow> & { id: string; trackId: string }): ProjectRow {
  return {
    title: o.id,
    trackName: o.trackId === "t1" ? "Developer tools" : "Climate",
    teamName: "team",
    duplicateOf: null,
    nAll: 3,
    n: 3,
    rawAll: 3,
    rawKept: 3,
    score: 3,
    se: 0.2,
    rankRaw: 1,
    rankKept: 1,
    rankNormalized: 1,
    trackRankRaw: 1,
    trackRank: 1,
    underReviewed: false,
    receipts: [],
    ...o,
  };
}

function judge(o: Partial<JudgeStanding> & { id: string }): JudgeStanding {
  return { name: o.id, n: 3, nAll: 3, leniency: 0, se: 0.1, shrink: 0.5, tilt: 0, flag: null, override: null, excluded: false, influence: null, ...o };
}

function run(o: Partial<Normalized> = {}): Normalized {
  const projects = [
    row({ id: "Slow Trail", trackId: "t1", score: 4.3, se: 0.2, trackRank: 1, rankNormalized: 1 }),
    row({ id: "Open Beacon", trackId: "t1", score: 3.6, se: 0.2, trackRank: 2, rankNormalized: 3 }),
    row({ id: "Green Lantern", trackId: "t2", score: 4.0, se: 0.25, trackRank: 1, rankNormalized: 2 }),
    row({ id: "Salt Loom", trackId: "t2", score: 3.9, se: 0.2, trackRank: 2, rankNormalized: 4, n: 1, underReviewed: true }),
  ];
  return {
    variance: { W: 1, beta2: 0.05, sigma2: 0.4, k: 8, measured: true },
    projects,
    judges: [judge({ id: "Ana" }), judge({ id: "Ben", n: 4 }), judge({ id: "Iva Petrova", excluded: true, flag: { judgeId: "Iva Petrova", reviews: 5, vector: [3, 3, 3] } })],
    ranked: 4,
    moved: 2,
    biggestMove: { id: "Open Beacon", title: "Open Beacon", from: 2, to: 3 },
    excluded: ["jdg_iva"],
    signal: null,
    yardstick: null,
    ...o,
  };
}

describe("plainSummary", () => {
  it("counts what is ranked: projects, tracks, counted reviews and the judges counted", () => {
    const [first] = plainSummary(run(), { open: 0, published: false });
    expect(first).toBe("4 projects in 2 tracks are ranked, from 10 counted reviews by 2 judges.");
  });

  it("says how many projects have no counted review yet", () => {
    const n = run();
    n.projects.push(row({ id: "Dry Compass", trackId: "t2", score: null, se: null, n: 0, trackRank: null, rankNormalized: null }));
    expect(plainSummary(n, { open: 0, published: false })[0]).toMatch(/1 project has no counted review yet, so it is not ranked\.$/);
  });

  it("names each track's first place, and calls a first place inside its margin a close call", () => {
    const lines = plainSummary(run(), { open: 0, published: false });
    expect(lines).toContain("First in Developer tools: Slow Trail, 4.30 ± 0.20.");
    expect(lines).toContain(
      "First in Climate: Green Lantern, 4.00 ± 0.25, only 0.10 ahead of Salt Loom: a gap inside the margin of error, so read it as a tie.",
    );
  });

  it("names a shared first place as a tie", () => {
    const n = run();
    n.projects[0] = { ...n.projects[0], trackRank: 1.5 };
    n.projects[1] = { ...n.projects[1], trackRank: 1.5, score: 4.3 };
    expect(plainSummary(n, { open: 0, published: false })).toContain("First in Developer tools: a tie between Slow Trail and Open Beacon, 4.30.");
  });

  it("says what evening out leniency changed, or that it changed nothing", () => {
    expect(plainSummary(run(), { open: 0, published: false })).toContain(
      "Evening out each judge's leniency moves 2 of the 4 projects by a place or more in the overall order; the most, Open Beacon, from 2nd to 3rd.",
    );
    expect(plainSummary(run({ moved: 0, biggestMove: null }), { open: 0, published: false })).toContain(
      "Evening out each judge's leniency changes no project's place.",
    );
    const shared = plainSummary(run({ moved: 1, biggestMove: { id: "x", title: "Open Beacon", from: 2.5, to: 11 } }), { open: 0, published: false });
    expect(shared).toContain("Evening out each judge's leniency moves 1 of the 4 projects by a place or more in the overall order; the most, Open Beacon, from a shared 2nd to 11th.");
  });

  it("says plainly when leniency could not be measured or was not there", () => {
    const unmeasured = run({ variance: { W: 0, beta2: 0, sigma2: 0, k: null, measured: false } });
    expect(plainSummary(unmeasured, { open: 0, published: false })).toContain(
      "No project has two counted reviews yet, so nothing is evened out: places come from the plain averages.",
    );
    const flat = run({ variance: { W: 1, beta2: 0, sigma2: 0.4, k: null, measured: true } });
    expect(plainSummary(flat, { open: 0, published: false })).toContain("The judges show no steady leniency, so places come from the plain averages.");
  });

  it("names the judges left out and the under-reviewed projects", () => {
    const lines = plainSummary(run(), { open: 0, published: false });
    expect(lines).toContain("Iva Petrova is left out for giving every project the same scores; you can count them again, with a reason, on the overview.");
    expect(lines).toContain("1 ranked project has fewer than two counted reviews and is marked under-reviewed.");
    const n = run();
    n.judges[1] = { ...n.judges[1], excluded: true, override: { judgeId: "Ben", mode: "exclude", id: "o1", reason: "conflict", createdAt: "", createdBy: "" } };
    expect(plainSummary(n, { open: 0, published: false })).toContain("Ben is left out by an organizer's decision; the reason is under the method below.");
  });

  it("ends with where the results stand: publishable, waiting on decisions (said once, in the header), or published", () => {
    expect(plainSummary(run(), { open: 0, published: false }).at(-1)).toBe("Nothing waits on you: you can publish from the overview.");
    expect(plainSummary(run(), { open: 2, published: false }).join(" ")).not.toMatch(/publish from the overview/);
    expect(plainSummary(run(), { open: 0, published: true }).at(-1)).toBe("These places are published; below is how they were worked out.");
  });

  it("an event with no reviews at all gets one honest line, not empty sums", () => {
    const empty = run({ projects: [row({ id: "A", trackId: "t1", score: null, se: null, n: 0, trackRank: null, rankNormalized: null })], ranked: 0, moved: 0, biggestMove: null, judges: [] });
    expect(plainSummary(empty, { open: 0, published: false })).toEqual(["No project has a counted review yet, so nothing is ranked."]);
  });
});
