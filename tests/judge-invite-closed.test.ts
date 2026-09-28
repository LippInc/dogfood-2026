import { describe, expect, it } from "vitest";
import { acceptJudgeInvite, inviteJudge, judgeInviteByCode } from "@/server/dal/judges";
import { actorById, addUser, auditRows, count, expectHttpError, organizer, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// A stale invitation link must not add a judge to a finished event: once the results are
// published, or judging has closed, accepting is a 409 that changes nothing, and the link's
// page says why before anyone presses the button.

withFixtureEvent();

const isJudge = (userId: string) => count("SELECT count(*) AS n FROM user_roles WHERE user_id = ? AND event_id = 'evt_01' AND role = 'judge'", userId) > 0;

function openInvite() {
  return inviteJudge(organizer(), "evt_01", { name: "Late", email: "", trackIds: ["trk_01"] });
}

describe("acceptJudgeInvite once judging is over", () => {
  it("positive control: an open link admits a judge while judging is open", () => {
    const invite = openInvite();
    const late = addUser("usr_late", "late@example.org", "Late");
    expect(judgeInviteByCode(invite.code).closed).toBeNull();
    acceptJudgeInvite(late, invite.code);
    expect(isJudge("usr_late")).toBe(true);
  });

  it("refuses with 409 results_published after the results are out, adding no role and no row", () => {
    const invite = openInvite();
    sqlRun("UPDATE events SET results_published_at = '2026-09-26T13:00:00.000Z' WHERE id = 'evt_01'");
    const late = addUser("usr_late", "late@example.org", "Late");
    const before = auditRows().length;
    expectHttpError(() => acceptJudgeInvite(late, invite.code), 409, "results_published");
    expect(isJudge("usr_late")).toBe(false);
    expect(count("SELECT count(*) AS n FROM judge_tracks WHERE judge_user_id = 'usr_late'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM judge_invites WHERE accepted_at IS NOT NULL")).toBe(0);
    expect(auditRows().length).toBe(before);
    expect(judgeInviteByCode(invite.code).closed).toMatch(/published/);
  });

  it("refuses with 409 judging_closed once the judging close has passed", () => {
    const invite = openInvite();
    sqlRun("UPDATE events SET judging_close_at = '2026-03-02T18:00:00.000Z' WHERE id = 'evt_01'");
    const late = addUser("usr_late", "late@example.org", "Late");
    const refusal = expectHttpError(() => acceptJudgeInvite(late, invite.code), 409, "judging_closed");
    expect(refusal.message).toContain("2026");
    expect(isJudge("usr_late")).toBe(false);
    expect(judgeInviteByCode(invite.code).closed).toMatch(/closed/);
  });

  it("a judging close still ahead lets the judge in", () => {
    const invite = openInvite();
    sqlRun("UPDATE events SET judging_close_at = '2999-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
    const late = addUser("usr_late", "late@example.org", "Late");
    acceptJudgeInvite(late, invite.code);
    expect(isJudge("usr_late")).toBe(true);
    expect(actorById("usr_late").roles).toContainEqual({ eventId: "evt_01", role: "judge" });
  });
});
