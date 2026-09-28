import { describe, expect, it } from "vitest";
import { getAssignments, runAssignment } from "@/server/dal/assignments";
import { getJudges, setJudgeTracks } from "@/server/dal/judges";
import { judgeSet } from "@/server/dal/judging";
import { getDb } from "@/server/db/client";
import { count, organizer, sqlAll, sqlGet, withFixtureEvent } from "./support/fixture-harness";

// An open review the judge can no longer see (the project is outside their tracks now) must not
// hold a seat: setJudgeTracks promised "a top-up run gives that project a judge from its track",
// but the engine counted every non-recused pair, so the project stayed a review short forever.

withFixtureEvent();

type Pending = { id: string; judge: string; project: string; track: string };

/**
 * After a top-up, one open review whose judge has another track to keep, in a track with a
 * counted judge who has not seen the project yet (so a refill is possible at all).
 */
function openReviewOfTwoTrackJudge(): Pending {
  runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
  const out = new Set(judgeSet(getDb(), "evt_01").excluded);
  const rows = sqlAll<Pending & { spare: string }>(
    `SELECT a.id, a.judge_user_id AS judge, a.project_id AS project, p.track_id AS track,
            (SELECT group_concat(jt.judge_user_id) FROM judge_tracks jt
              WHERE jt.track_id = p.track_id AND jt.judge_user_id NOT IN (SELECT b.judge_user_id FROM assignments b WHERE b.project_id = a.project_id)) AS spare
       FROM assignments a JOIN projects p ON p.id = a.project_id
      WHERE a.event_id = 'evt_01' AND a.status = 'pending'
        AND (SELECT count(*) FROM judge_tracks jt WHERE jt.judge_user_id = a.judge_user_id AND jt.event_id = 'evt_01') >= 2
      ORDER BY a.id`,
  ).filter((r) => (r.spare ?? "").split(",").some((j) => j && !out.has(j)));
  expect(rows.length).toBeGreaterThan(0);
  return rows[0]!;
}

const tracksOf = (judge: string) => sqlAll<{ t: string }>("SELECT track_id AS t FROM judge_tracks WHERE judge_user_id = ? AND event_id = 'evt_01'", judge).map((r) => r.t);

describe("a top-up refills a review its judge can no longer see", () => {
  it("positive control: right after a top-up there is nothing to add", () => {
    openReviewOfTwoTrackJudge();
    expect(getAssignments(organizer(), "evt_01").wouldAdd).toBe(0);
  });

  it("taking the project's track from the judge frees the seat: the next top-up gives the project another judge", () => {
    const open = openReviewOfTwoTrackJudge();
    const judgeRowBefore = getJudges(organizer(), "evt_01").judges.find((j) => j.id === open.judge)!;
    const inThatTrack = count(
      "SELECT count(*) AS n FROM assignments a JOIN projects p ON p.id = a.project_id WHERE a.judge_user_id = ? AND a.status = 'pending' AND p.track_id = ?",
      open.judge,
      open.track,
    );
    setJudgeTracks(organizer(), "evt_01", open.judge, { trackIds: tracksOf(open.judge).filter((t) => t !== open.track) });

    expect(getAssignments(organizer(), "evt_01").wouldAdd).toBeGreaterThanOrEqual(1);
    const run = runAssignment(organizer(), "evt_01", { mode: "topup", seed: 7 });
    const refill = sqlGet<{ judge: string }>("SELECT judge_user_id AS judge FROM assignments WHERE run_id = ? AND project_id = ?", run.runId, open.project);
    expect(refill, "the project gets a new judge").toBeDefined();
    expect(refill!.judge).not.toBe(open.judge);
    expect(tracksOf(refill!.judge)).toContain(open.track);

    // the old pair stays in the data, out of the judge's open count
    expect(count("SELECT count(*) AS n FROM assignments WHERE id = ?", open.id)).toBe(1);
    const judgeRowAfter = getJudges(organizer(), "evt_01").judges.find((j) => j.id === open.judge)!;
    expect(judgeRowAfter.pending).toBe(judgeRowBefore.pending - inThatTrack);
  });
});
