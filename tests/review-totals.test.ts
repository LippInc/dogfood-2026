import { describe, expect, it } from "vitest";
import { getJudgeScores } from "@/server/dal/scores";
import { actorById, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// A judge's own list shows each finished review's total: Σ weight × value ÷ Σ weight over the event's criteria,
// the same number the ranking uses; a review missing a criterion shows none. Checked against the rows themselves.

withFixtureEvent();

const expectedTotal = (assignmentId: string) => {
  const rows = sqlAll<{ value: number; weight: number }>(
    `SELECT i.value, c.weight FROM scores s JOIN score_items i ON i.score_id = s.id JOIN rubric_criteria c ON c.id = i.criterion_id
     WHERE s.assignment_id = ? ORDER BY c.position`,
    assignmentId,
  );
  let sum = 0;
  let weights = 0;
  for (const r of rows) {
    sum += r.weight * r.value;
    weights += r.weight;
  }
  return sum / weights;
};

describe("the totals on a judge's own reviews", () => {
  it("are the weighted mean of the scored criteria, and absent while a criterion is missing", () => {
    const judge = sqlGet<{ id: string }>(
      `SELECT a.judge_user_id AS id FROM assignments a JOIN scores s ON s.assignment_id = a.id
       GROUP BY a.judge_user_id ORDER BY count(*) DESC, a.judge_user_id LIMIT 1`,
    )!.id;
    // unequal weights, so a plain mean would differ
    sqlRun("UPDATE rubric_criteria SET weight = position + 1 WHERE event_id = 'evt_01'");
    const reviews = getJudgeScores(actorById(judge), null).reviews;
    const scored = reviews.filter((r) => r.total !== null);
    expect(scored.length).toBeGreaterThan(0);
    for (const r of scored) expect(r.total).toBe(expectedTotal(r.assignmentId));
    expect(scored.some((r) => r.total !== r.items.reduce((s, i) => s + i.value, 0) / r.items.length)).toBe(true);

    const partial = scored[0]!;
    sqlRun(
      "DELETE FROM score_items WHERE rowid = (SELECT i.rowid FROM score_items i JOIN scores s ON s.id = i.score_id WHERE s.assignment_id = ? LIMIT 1)",
      partial.assignmentId,
    );
    const again = getJudgeScores(actorById(judge), null).reviews.find((r) => r.assignmentId === partial.assignmentId)!;
    expect(again.total).toBeNull();
  });
});
