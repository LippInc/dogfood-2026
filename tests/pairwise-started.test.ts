import { describe, expect, it } from "vitest";
import { runAssignment } from "@/server/dal/assignments";
import { getProjectJudging, moveProjectTrack, removeAssignment, removeJudge } from "@/server/dal/corrections";
import { computePairwise, getPairwiseState, pickPairwise, setJudgingMode } from "@/server/dal/pairwise";
import { requireEvent } from "@/server/dal/events";
import { getDb } from "@/server/db/client";
import { actorById, count, expectHttpError, organizer, sqlAll, sqlGet, withFixtureEvent } from "./support/fixture-harness";

// In pairwise mode a judge's work is their answers (comparisons rows), not scores rows. Before
// this, every place that decided whether a review was "started" looked only at scores: an
// assignment whose project the judge had already compared was taken back (or withdrawn by a
// track move or a judge removal) as "unstarted", while its answers kept moving the ranking.

withFixtureEvent();

type Asg = { id: string; judge: string; project: string; track: string };

const answersAbout = (judge: string, project: string) =>
  count(
    "SELECT count(*) AS n FROM comparisons WHERE event_id = 'evt_01' AND judge_user_id = ? AND voided_at IS NULL AND (left_project_id = ? OR right_project_id = ?)",
    judge,
    project,
    project,
  );
const hasScores = (asg: string) => count("SELECT count(*) AS n FROM scores WHERE assignment_id = ?", asg) > 0;
const exists = (asg: string) => count("SELECT count(*) AS n FROM assignments WHERE id = ?", asg) > 0;

/**
 * Pairwise mode after a top-up: a judge answers questions in one track until an open review
 * with no scores row has a project they compared. Returns that review, and one untouched open
 * review of another judge (the positive control).
 */
function answeredButUnscored(): { asg: Asg; untouched: Asg } {
  setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
  runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
  const open = sqlAll<Asg>(
    `SELECT a.id, a.judge_user_id AS judge, a.project_id AS project, p.track_id AS track
       FROM assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.event_id = 'evt_01' AND a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id)
        AND EXISTS (SELECT 1 FROM judge_tracks jt WHERE jt.judge_user_id = a.judge_user_id AND jt.track_id = p.track_id)
      ORDER BY a.id`,
  );
  for (const asg of open) {
    const judge = actorById(asg.judge);
    for (let i = 0; i < 60 && answersAbout(asg.judge, asg.project) === 0; i++) {
      const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.trackId === asg.track);
      if (!t?.current) break;
      pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current.left.id, right: t.current.right.id, outcome: "left" });
    }
    if (answersAbout(asg.judge, asg.project) > 0 && !hasScores(asg.id)) {
      const untouched = open.find((o) => o.judge !== asg.judge && answersAbout(o.judge, o.project) === 0)!;
      return { asg, untouched };
    }
  }
  throw new Error("no open review got an answer: the set-up no longer fits the fixture");
}

describe("pairwise answers count as a started review", () => {
  it("the set-up is real: the answers move the ranking though no scores row exists", () => {
    const { asg } = answeredButUnscored();
    expect(hasScores(asg.id)).toBe(false);
    const pw = computePairwise(getDb(), requireEvent(getDb(), "evt_01"));
    const receipts = pw.receipts.get(asg.project) ?? [];
    expect(receipts.some((r) => r.kind === "pick")).toBe(true);
  });

  it("the project page shows the review as started", () => {
    const { asg, untouched } = answeredButUnscored();
    const view = getProjectJudging(organizer(), "evt_01", asg.project);
    expect(view.assignments.find((a) => a.id === asg.id)?.started).toBe(true);
    // control: a review nobody touched still shows as not started
    expect(getProjectJudging(organizer(), "evt_01", untouched.project).assignments.find((a) => a.id === untouched.id)?.started).toBe(false);
  });

  it("taking the review back is refused with 409 review_started; an untouched one still can be (control)", () => {
    const { asg, untouched } = answeredButUnscored();
    expectHttpError(() => removeAssignment(organizer(), "evt_01", asg.id, { reason: "picked by mistake" }), 409, "review_started");
    expect(exists(asg.id)).toBe(true);
    removeAssignment(organizer(), "evt_01", untouched.id, { reason: "picked by mistake" });
    expect(exists(untouched.id)).toBe(false);
  });

  it("moving the project to a track its judge does not judge keeps the review as started, not withdrawn", () => {
    const { asg } = answeredButUnscored();
    const to = sqlGet<{ id: string }>(
      "SELECT id FROM tracks t WHERE event_id = 'evt_01' AND id <> ? AND NOT EXISTS (SELECT 1 FROM judge_tracks jt WHERE jt.track_id = t.id AND jt.judge_user_id = ?) ORDER BY position LIMIT 1",
      asg.track,
      asg.judge,
    )!.id;
    const out = moveProjectTrack(organizer(), "evt_01", asg.project, { trackId: to, reason: "The team entered the wrong track" });
    expect(exists(asg.id)).toBe(true);
    expect(out.startedKept).toBeGreaterThanOrEqual(1);
  });

  it("removing the judge keeps the answered review in the record (kept, not withdrawn)", () => {
    const { asg } = answeredButUnscored();
    const out = removeJudge(organizer(), "evt_01", asg.judge, { reason: "had to leave" });
    expect(out.voided).toBe(true);
    expect(exists(asg.id)).toBe(true);
  });
});
