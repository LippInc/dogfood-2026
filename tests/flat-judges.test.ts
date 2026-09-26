import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { finishedReviews, judgeSet, rubricOf } from "@/server/dal/judging";
import { excludedJudges, flatJudges, type FinishedReview, type FlatFlag } from "@/server/judging/flat";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
});

afterEach(() => {
  h.sqlite.close();
});

const review = (judgeId: string, projectId: string, values: number[]): FinishedReview => ({
  judgeId,
  projectId,
  values,
});

describe("flatJudges (pure)", () => {
  it("flags a judge with three identical vectors, with the count and the vector", () => {
    const reviews = [
      review("j1", "p1", [4, 4, 4]),
      review("j1", "p2", [4, 4, 4]),
      review("j1", "p3", [4, 4, 4]),
      review("j2", "p1", [3, 4, 2]),
      review("j2", "p2", [3, 4, 3]),
      review("j2", "p3", [4, 4, 2]),
    ];
    expect(flatJudges(reviews)).toEqual([{ judgeId: "j1", reviews: 3, vector: [4, 4, 4] }]);
  });

  it("does not flag two identical vectors: below minReviews", () => {
    const reviews = [review("j1", "p1", [5, 5, 5]), review("j1", "p2", [5, 5, 5])];
    expect(flatJudges(reviews)).toEqual([]);
  });

  it("flags two identical vectors when minReviews is lowered to 2", () => {
    const reviews = [review("j1", "p1", [5, 5, 5]), review("j1", "p2", [5, 5, 5])];
    expect(flatJudges(reviews, 2)).toEqual([{ judgeId: "j1", reviews: 2, vector: [5, 5, 5] }]);
  });

  it("known-bad: three vectors that differ in one criterion are not flat", () => {
    const reviews = [
      review("j1", "p1", [4, 4, 4]),
      review("j1", "p2", [4, 4, 4]),
      review("j1", "p3", [4, 5, 4]), // one criterion off
    ];
    expect(flatJudges(reviews)).toEqual([]);
  });

  it("returns several flags sorted by judge id", () => {
    const reviews = [
      review("jB", "p1", [2, 2, 2]),
      review("jB", "p2", [2, 2, 2]),
      review("jB", "p3", [2, 2, 2]),
      review("jA", "p1", [1, 2, 3]),
      review("jA", "p2", [1, 2, 3]),
      review("jA", "p3", [1, 2, 3]),
    ];
    expect(flatJudges(reviews).map((f) => f.judgeId)).toEqual(["jA", "jB"]);
  });
});

describe("excludedJudges (pure)", () => {
  const flags: FlatFlag[] = [
    { judgeId: "jdg_19", reviews: 4, vector: [2, 2, 2] },
    { judgeId: "jdg_07", reviews: 3, vector: [4, 4, 4] },
  ];

  it("excludes every flagged judge when there are no overrides", () => {
    expect(excludedJudges(flags, [])).toEqual(["jdg_07", "jdg_19"]);
  });

  it("an include override reinstates a flagged judge", () => {
    expect(excludedJudges(flags, [{ judgeId: "jdg_07", mode: "include" }])).toEqual(["jdg_19"]);
  });

  it("an exclude override adds an unflagged judge", () => {
    expect(excludedJudges(flags, [{ judgeId: "jdg_02", mode: "exclude" }])).toEqual(["jdg_02", "jdg_07", "jdg_19"]);
  });

  it("returns a sorted list with no duplicates, even for a judge both flagged and excluded by hand", () => {
    const out = excludedJudges(flags, [
      { judgeId: "jdg_19", mode: "exclude" },
      { judgeId: "jdg_19", mode: "exclude" },
    ]);
    expect(out).toEqual(["jdg_07", "jdg_19"]);
    expect([...out].sort()).toEqual(out);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("the flat-judge rule on the fixture (database)", () => {
  it("finishedReviews returns 126 reviews with 3 values each, in rubric order", () => {
    const criteria = rubricOf(h.db, "evt_01");
    expect(criteria).toHaveLength(3);
    const at = new Map(criteria.map((c, i) => [c.id, i]));
    const reviews = finishedReviews(h.db, "evt_01");
    expect(reviews).toHaveLength(126);
    for (const r of reviews) {
      expect(r.values).toHaveLength(3);
      // cross-check the order against the raw rows, not the loader's own mapping
      const items = h.sqlite
        .prepare("SELECT criterion_id, value FROM score_items WHERE score_id = ?")
        .all(r.scoreId) as { criterion_id: string; value: number }[];
      const expected = new Array<number>(criteria.length);
      for (const item of items) expected[at.get(item.criterion_id)!] = item.value;
      expect(r.values).toEqual(expected);
    }
  });

  it("flags exactly jdg_07, with vector [4, 4, 4]", () => {
    const flags = flatJudges(finishedReviews(h.db, "evt_01"));
    console.log("flat judges:", flags.length);
    expect(flags).toEqual([{ judgeId: "jdg_07", reviews: 3, vector: [4, 4, 4] }]);
  });

  it("judgeSet wires the flags and overrides into the excluded list", () => {
    const set = judgeSet(h.db, "evt_01");
    expect(set.flags.map((f) => f.judgeId)).toEqual(["jdg_07"]);
    expect(set.overrides).toEqual([]);
    expect(set.excluded).toEqual(["jdg_07"]);
  });

  it("known-bad: break one jdg_07 review and the flag disappears", () => {
    h.sqlite
      .prepare(
        `DELETE FROM score_items WHERE rowid = (
          SELECT si.rowid FROM score_items si
          JOIN scores s ON s.id = si.score_id
          JOIN assignments a ON a.id = s.assignment_id
          WHERE a.judge_user_id = 'jdg_07'
          LIMIT 1
        )`,
      )
      .run();
    const reviews = finishedReviews(h.db, "evt_01");
    expect(reviews).toHaveLength(125);
    expect(reviews.filter((r) => r.judgeId === "jdg_07")).toHaveLength(2);
    expect(flatJudges(reviews)).toEqual([]);
  });
});
