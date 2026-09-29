import { describe, expect, it } from "vitest";
import { plainSummary } from "@/app/organize/[event]/results/plain-summary";
import type { JudgeStanding, Normalized, ProjectRow } from "@/server/dal";

// A results-day organizer met k, β̂² and a permutation share before any plain sentence (round-3 tester).
// plainSummary says what the run shows in words, one point each, above the statistics. Each point is
// said once: the first places in one line, the close calls in one line (the first draft gave every
// track its own line and repeated the margin-of-error clause in seven of them), and the leniency line
// counts only what evening out leniency moves (the first draft's count also held the moves from leaving
// a judge out, which Fig. 01 right below counts on its own, so the two numbers disagreed).

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
  return { name: o.id, n: 3, nAll: 3, leniency: 0, se: 0.1, shrink: 0.5, tilt: 0, kept: null, flag: null, override: null, excluded: false, removed: false, influence: null, ...o };
}

function run(o: Partial<Normalized> = {}): Normalized {
  const projects = [
    row({ id: "Slow Trail", trackId: "t1", score: 4.3, se: 0.2, trackRank: 1, rankKept: 1, rankNormalized: 1, rankRaw: 1 }),
    row({ id: "Open Beacon", trackId: "t1", score: 3.6, se: 0.2, trackRank: 2, rankKept: 2, rankNormalized: 3, rankRaw: 4 }),
    row({ id: "Green Lantern", trackId: "t2", score: 4.0, se: 0.25, trackRank: 1, rankKept: 3, rankNormalized: 2, rankRaw: 2 }),
    row({ id: "Salt Loom", trackId: "t2", score: 3.9, se: 0.2, trackRank: 2, rankKept: 4, rankNormalized: 4, rankRaw: 3, n: 1, underReviewed: true }),
  ];
  return {
    variance: { W: 1, beta2: 0.05, sigma2: 0.4, k: 8, measured: true, leniencyMeasured: true },
    projects,
    judges: [judge({ id: "Ana" }), judge({ id: "Ben", n: 4 }), judge({ id: "Iva Petrova", excluded: true, flag: { judgeId: "Iva Petrova", reviews: 5, vector: [3, 3, 3] } })],
    ranked: 4,
    // raw → normalized, leaving Iva out included: not what the leniency line may count
    moved: 3,
    biggestMove: { id: "Open Beacon", title: "Open Beacon", from: 4, to: 3 },
    excluded: ["jdg_iva"],
    signal: null,
    yardstick: null,
    ...o,
  };
}

const say = (n: Normalized, open = 0, published = false) => plainSummary(n, { open, published });

describe("plainSummary", () => {
  it("counts what is ranked: projects, tracks, counted reviews and the judges counted", () => {
    expect(say(run())[0]).toBe("4 projects in 2 tracks are ranked, from 10 counted reviews by 2 judges.");
  });

  it("says how many projects have no counted review yet", () => {
    const n = run();
    n.projects.push(row({ id: "Dry Compass", trackId: "t2", score: null, se: null, n: 0, trackRank: null, rankKept: null, rankNormalized: null }));
    expect(say(n)[0]).toMatch(/1 project has no counted review yet, so it is not ranked\.$/);
  });

  it("names every track's first place in one point", () => {
    expect(say(run())).toContain("First in each track: Slow Trail (Developer tools); Green Lantern (Climate).");
  });

  it("names a shared first place as tied", () => {
    const n = run();
    n.projects[0] = { ...n.projects[0]!, trackRank: 1.5 };
    n.projects[1] = { ...n.projects[1]!, trackRank: 1.5, score: 4.3 };
    expect(say(n)).toContain("First in each track: Slow Trail and Open Beacon, tied (Developer tools); Green Lantern (Climate).");
  });

  it("says once which first places are too close to call, by the close-call rule the Results page and the Overview use", () => {
    // Climate: 4.00 ahead of 3.90, inside ± 0.25; Developer tools: 4.30 ahead of 3.60, well clear
    expect(say(run())).toContain("In Climate, first place is too close to call from the scores: see Close calls below.");
    const all = run();
    all.projects[1] = { ...all.projects[1]!, score: 4.25 };
    expect(say(all)).toContain("In every track first place is too close to call from the scores: see Close calls below.");
    const clear = run();
    clear.projects[3] = { ...clear.projects[3]!, score: 3.2 };
    expect(say(clear)).toContain("Every first place is clear from the scores: each leader comes out first in at least 95 % of the draws around the scores' ±.");
    // a lead of 1.3 standard errors of the difference is more than one ± (the old rule called it clear) but first in only about 90 % of the draws
    const between = run();
    between.projects[3] = { ...between.projects[3]!, score: 4.0 - 1.3 * Math.sqrt(0.25 ** 2 + 0.2 ** 2) };
    expect(say(between)).toContain("In Climate, first place is too close to call from the scores: see Close calls below.");
  });

  it("names the close tracks when some but not all are close", () => {
    const n = run();
    n.projects.push(
      row({ id: "Iron Switch", trackId: "t3", trackName: "Security", score: 4.1, se: 0.3, trackRank: 1, rankKept: 5, rankNormalized: 5 }),
      row({ id: "North Drift", trackId: "t3", trackName: "Security", score: 4.0, se: 0.3, trackRank: 2, rankKept: 6, rankNormalized: 6 }),
    );
    expect(say(n)).toContain("In 2 of the 3 tracks first place is too close to call from the scores: Climate and Security; see Close calls below.");
    // a tied track has no lead to measure: the count says which tracks it is out of
    n.projects.push(
      row({ id: "Salt Kiln", trackId: "t4", trackName: "Health", score: 3.5, se: 0.3, trackRank: 1.5, rankKept: 7, rankNormalized: 7 }),
      row({ id: "Warm Beacon", trackId: "t4", trackName: "Health", score: 3.5, se: 0.3, trackRank: 1.5, rankKept: 8, rankNormalized: 8 }),
    );
    expect(say(n)).toContain(
      "In 2 of the 3 tracks with one leader first place is too close to call from the scores: Climate and Security; see Close calls below.",
    );
  });

  it("counts what evening out leniency moves, apart from leaving a judge out, which Fig. 01 counts", () => {
    expect(say(run())).toContain(
      "Evening out each judge's leniency moves 2 of the 4 projects by a place or more in the overall order; the most, Open Beacon, from 2nd to 3rd.",
    );
    const still = run();
    still.projects = still.projects.map((p) => ({ ...p, rankNormalized: p.rankKept }));
    expect(say(still)).toContain("Evening out each judge's leniency changes no project's place.");
    const shared = run();
    shared.projects[1] = { ...shared.projects[1]!, rankKept: 2.5, rankNormalized: 11 };
    expect(say(shared)).toContain(
      "Evening out each judge's leniency moves 2 of the 4 projects by a place or more in the overall order; the most, Open Beacon, from a shared 2nd to 11th.",
    );
  });

  const TOO_FEW = "Too few reviews to estimate how lenient each judge is, so scores are used as given: places come from the plain averages.";

  it("says plainly when leniency could not be measured or was not there", () => {
    const unmeasured = run({ variance: { W: 0, beta2: 0, sigma2: 0, k: null, measured: false, leniencyMeasured: false } });
    expect(say(unmeasured)).toContain("No project has two counted reviews yet, so nothing is evened out: places come from the plain averages.");
    // Two judges on one project: the noise is measured, but no judge's leniency can be.
    const tooFew = run({ variance: { W: 1, beta2: 0, sigma2: 1, k: null, measured: true, leniencyMeasured: false } });
    expect(say(tooFew)).toContain(TOO_FEW);
    expect(say(tooFew)).not.toContain("The judges show no steady leniency");
    const flat = run({ variance: { W: 1, beta2: 0, sigma2: 0.4, k: null, measured: true, leniencyMeasured: true } });
    expect(say(flat)).toContain("The judges show no steady leniency, so places come from the plain averages.");
    expect(say(flat)).not.toContain(TOO_FEW);
  });

  it("names the judges left out and why, and the under-reviewed projects", () => {
    const lines = say(run());
    expect(lines).toContain("Iva Petrova is left out for giving every project the same scores; you can count them again, with a reason, on the overview.");
    expect(lines).toContain("1 ranked project has fewer than two counted reviews and is marked under-reviewed.");
    const n = run();
    n.judges[1] = { ...n.judges[1]!, excluded: true, override: { judgeId: "Ben", mode: "exclude", id: "o1", reason: "conflict", createdAt: "", createdBy: "" } };
    expect(say(n)).toContain("Ben is left out by an organizer's decision; the reason is under the method below.");
  });

  it("ends with where the results stand: publishable, waiting on decisions (said once, in the header), or published", () => {
    expect(say(run()).at(-1)).toBe("Nothing waits on you: you can publish from the overview.");
    expect(say(run(), 2).join(" ")).not.toMatch(/publish from the overview/);
    expect(say(run(), 0, true).at(-1)).toBe("These places are published; below is how they were worked out.");
    // after publishing, a live view that no longer matches the stored run never calls its places the published ones
    const drifted = plainSummary(run(), { open: 0, published: true, differs: 3 });
    expect(drifted.join(" ")).not.toMatch(/These places are published/);
    expect(drifted.at(-1)).toMatch(/differ from the published ones/);
  });

  it("stays short: one point per kind of fact, however many tracks", () => {
    const n = run();
    for (let t = 3; t <= 9; t++)
      n.projects.push(
        row({ id: `A${t}`, trackId: `t${t}`, trackName: `Track ${t}`, score: 4, se: 0.3, trackRank: 1, rankKept: 10 + t, rankNormalized: 10 + t }),
        row({ id: `B${t}`, trackId: `t${t}`, trackName: `Track ${t}`, score: 3.9, se: 0.3, trackRank: 2, rankKept: 30 + t, rankNormalized: 30 + t }),
      );
    expect(say(n).length).toBeLessThanOrEqual(7);
  });

  it("an event with no reviews at all gets one honest line, not empty sums", () => {
    const empty = run({ projects: [row({ id: "A", trackId: "t1", score: null, se: null, n: 0, trackRank: null, rankKept: null, rankNormalized: null })], ranked: 0, judges: [] });
    expect(say(empty)).toEqual(["No project has a counted review yet, so nothing is ranked."]);
  });
});
