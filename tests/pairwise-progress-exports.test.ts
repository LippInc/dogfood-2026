import { describe, expect, it } from "vitest";
import { runAssignment } from "@/server/dal/assignments";
import { removeAssignment } from "@/server/dal/corrections";
import { exportFile } from "@/server/dal/exports";
import { getJudges } from "@/server/dal/judges";
import { getPairwiseState, pickPairwise, setJudgingMode, undoPairwise } from "@/server/dal/pairwise";
import { actorById, count, expectHttpError, organizer, sqlAll, sqlGet, withFixtureEvent } from "./support/fixture-harness";
import { parseCsv } from "./support/csv";

// Pairwise mode never writes a scores row, so assignments.csv (its review and last_saved_at columns) and the judges
// API's started count read a judge with standing answers as "none" and 0, while taking such an assignment back is
// refused as review_started and the Judges page says the judge has started. They now share one rule (answeredPairs):
// an assignment is started when its project is in one of its judge's standing answers.

withFixtureEvent();

type Answer = { id: string; judge: string; track: string; left: string; right: string; at: string };

/**
 * Pairwise mode after a top-up; one judge answers exactly one question, chosen so that at least one of its two
 * projects is an open review of theirs with no scores row (the fixture's imported reviews have scores rows).
 */
function oneAnswer(): Answer {
  setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
  runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
  const open = sqlAll<{ judge: string; project: string; track: string }>(
    `SELECT a.judge_user_id AS judge, a.project_id AS project, p.track_id AS track
       FROM assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.event_id = 'evt_01' AND a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id)
        AND EXISTS (SELECT 1 FROM judge_tracks jt WHERE jt.judge_user_id = a.judge_user_id AND jt.track_id = p.track_id)
      ORDER BY a.id`,
  );
  for (const o of open) {
    const judge = actorById(o.judge);
    const q = getPairwiseState(judge, "evt_01").tracks.find((x) => x.trackId === o.track)?.current;
    if (!q || !open.some((x) => x.judge === o.judge && (x.project === q.left.id || x.project === q.right.id))) continue;
    pickPairwise(judge, "evt_01", { trackId: o.track, left: q.left.id, right: q.right.id, outcome: "left" });
    return sqlGet<Answer>(
      "SELECT id, judge_user_id AS judge, track_id AS track, left_project_id AS left, right_project_id AS right, created_at AS at FROM comparisons WHERE event_id = 'evt_01' AND voided_at IS NULL",
    )!;
  }
  throw new Error("no question touches an unscored open review: the set-up no longer fits the fixture");
}
const hasScores = (assignmentId: string) => count("SELECT count(*) AS n FROM scores WHERE assignment_id = ?", assignmentId) > 0;

const rows = () => parseCsv(exportFile(organizer(), "evt_01", "assignments.csv").body);
const rowOf = (judge: string, project: string) => rows().find((r) => r.judge_id === judge && r.project_id === project);
const judgeRow = (judge: string) => getJudges(organizer(), "evt_01").judges.find((j) => j.id === judge)!;
/** Counted straight from the tables: the judge's assignments with a review row or a standing answer about the project. */
const startedInDb = (judge: string) =>
  count(
    `SELECT count(*) AS n FROM assignments a
      WHERE a.event_id = 'evt_01' AND a.judge_user_id = ?
        AND (EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id)
          OR EXISTS (SELECT 1 FROM comparisons c WHERE c.event_id = a.event_id AND c.judge_user_id = a.judge_user_id AND c.voided_at IS NULL
                       AND a.project_id IN (c.left_project_id, c.right_project_id)))`,
    judge,
  );

describe("pairwise progress in assignments.csv", () => {
  it("both projects of one answer read answered, with the answer's time; an untouched review still reads none", () => {
    const a = oneAnswer();
    const mine = [a.left, a.right].map((p) => rowOf(a.judge, p)).filter((r) => r !== undefined);
    const unscored = mine.filter((r) => !hasScores(r.assignment_id));
    // the set-up is real: at least one of the two projects is an open review of this judge with no scores row
    expect(unscored.length).toBeGreaterThanOrEqual(1);
    for (const r of unscored) {
      expect({ review: r.review, last_saved_at: r.last_saved_at, submitted_at: r.submitted_at }).toEqual({ review: "answered", last_saved_at: a.at, submitted_at: "" });
      // the rule the CSV now shows is the one removeAssignment enforces
      expectHttpError(() => removeAssignment(organizer(), "evt_01", r.assignment_id, { reason: "picked by mistake" }), 409, "review_started");
    }
    // a review with a scores row keeps what its scores row says
    for (const r of mine.filter((x) => hasScores(x.assignment_id))) expect(["draft", "submitted"]).toContain(r.review);
    // control: an open review of another judge, whose project they never compared, reads none with no time
    const other = rows().find((r) => r.judge_id !== a.judge && r.status === "pending" && !hasScores(r.assignment_id))!;
    expect({ review: other.review, last_saved_at: other.last_saved_at }).toEqual({ review: "none", last_saved_at: "" });
  });

  it("last_saved_at is the latest standing answer about the project", () => {
    const a = oneAnswer();
    const judge = actorById(a.judge);
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.trackId === a.track)!;
    if (!t.current) return; // nothing more to ask in this track: the first test covers the single answer
    pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current.left.id, right: t.current.right.id, outcome: "right" });
    const answeredRows = rows().filter((x) => x.judge_id === a.judge && x.review === "answered");
    expect(answeredRows.length).toBeGreaterThanOrEqual(1);
    for (const r of answeredRows) {
      const latest = sqlGet<{ at: string }>(
        "SELECT max(created_at) AS at FROM comparisons WHERE event_id = 'evt_01' AND judge_user_id = ? AND voided_at IS NULL AND ? IN (left_project_id, right_project_id)",
        a.judge,
        r.project_id,
      )!.at;
      expect(r.last_saved_at).toBe(latest);
    }
  });

  it("a taken-back answer does not count: the rows go back to none", () => {
    const a = oneAnswer();
    const unscored = [a.left, a.right].map((p) => rowOf(a.judge, p)).filter((r) => r !== undefined && !hasScores(r.assignment_id));
    expect(unscored.map((r) => r!.review)).toContain("answered");
    undoPairwise(actorById(a.judge), "evt_01", { trackId: a.track });
    for (const r of unscored) {
      const now = rowOf(a.judge, r!.project_id)!;
      expect({ review: now.review, last_saved_at: now.last_saved_at }).toEqual({ review: "none", last_saved_at: "" });
    }
  });

  it("switched back to scores, an answered review still reads answered, as removeAssignment still refuses it", () => {
    const a = oneAnswer();
    setJudgingMode(organizer(), "evt_01", { mode: "scores", reason: "back to scores after all" });
    const r = [a.left, a.right].map((p) => rowOf(a.judge, p)).find((x) => x !== undefined && !hasScores(x.assignment_id))!;
    expect({ review: r.review, last_saved_at: r.last_saved_at }).toEqual({ review: "answered", last_saved_at: a.at });
    expectHttpError(() => removeAssignment(organizer(), "evt_01", r.assignment_id, { reason: "picked by mistake" }), 409, "review_started");
  });

  it("a scores event keeps its values: submitted, draft or none from the review row", () => {
    const values = new Set(rows().map((r) => r.review));
    expect(values.has("submitted")).toBe(true);
    for (const v of values) expect(["none", "draft", "submitted"]).toContain(v);
  });
});

describe("pairwise progress in the judges API", () => {
  it("started counts the reviews whose project the judge answered about, and agrees with the Judges page", () => {
    const before = oneAnswerBaseline();
    const a = before.answer;
    const j = judgeRow(a.judge);
    expect(j.started).toBe(startedInDb(a.judge));
    expect(j.started).toBeGreaterThan(before.scoredOnly);
    // the Judges page reads notStarted; a judge counted as started is never listed as not started
    expect(j.notStarted).toBe(false);
  });

  it("a taken-back answer does not count", () => {
    const before = oneAnswerBaseline();
    const a = before.answer;
    undoPairwise(actorById(a.judge), "evt_01", { trackId: a.track });
    expect(judgeRow(a.judge).started).toBe(before.scoredOnly);
  });

  it("every judge's started matches the tables (control across the event)", () => {
    oneAnswer();
    for (const j of getJudges(organizer(), "evt_01").judges) expect(j.started, j.name).toBe(startedInDb(j.id));
  });
});

/** oneAnswer, plus how many of that judge's reviews have a scores row (their started count without the answer). */
function oneAnswerBaseline() {
  const answer = oneAnswer();
  const scoredOnly = count(
    "SELECT count(*) AS n FROM assignments a WHERE a.event_id = 'evt_01' AND a.judge_user_id = ? AND EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id)",
    answer.judge,
  );
  return { answer, scoredOnly };
}
