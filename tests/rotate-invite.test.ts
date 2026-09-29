import { beforeEach, describe, expect, it } from "vitest";
import { rotateInvite } from "@/server/dal/teams";
import { actorById, auditRows, count, expectHttpError, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Replacing a team's invite link: the captain only, audited once; a team that does not exist is 404 and someone
// on another team is refused as not the captain, with one refusal row.

withFixtureEvent();

let captain: { userId: string; teamId: string };
let otherTeamMember: string;

beforeEach(() => {
  sqlRun("UPDATE events SET submissions_close_at = '2099-01-01T00:00:00.000Z' WHERE id = 'evt_01'");
  captain = sqlGet<{ userId: string; teamId: string }>("SELECT user_id AS userId, team_id AS teamId FROM team_members WHERE event_id = 'evt_01' AND role = 'captain' ORDER BY team_id LIMIT 1")!;
  otherTeamMember = sqlGet<{ id: string }>("SELECT user_id AS id FROM team_members WHERE event_id = 'evt_01' AND team_id <> ? ORDER BY user_id LIMIT 1", captain.teamId)!.id;
});

describe("rotateInvite", () => {
  it("the captain gets a new code, stored, and one audit row names the team (positive control)", () => {
    const before = sqlGet<{ code: string }>("SELECT invite_code AS code FROM teams WHERE id = ?", captain.teamId)!.code;
    const { inviteCode } = rotateInvite(actorById(captain.userId), captain.teamId);
    expect(inviteCode).not.toBe(before);
    expect(sqlGet<{ code: string }>("SELECT invite_code AS code FROM teams WHERE id = ?", captain.teamId)!.code).toBe(inviteCode);
    const rows = auditRows().filter((r) => r.action === "team.invite_rotated");
    expect(rows.map((r) => [r.targetType, r.targetId, r.eventId, r.actorUserId])).toEqual([["team", captain.teamId, "evt_01", captain.userId]]);
  });

  it("known-bad: a team that does not exist is 404 and writes nothing", () => {
    const n = count("SELECT count(*) AS n FROM audit_log");
    expectHttpError(() => rotateInvite(actorById(captain.userId), "tm_no_such_team"), 404, "not_found");
    expect(count("SELECT count(*) AS n FROM audit_log")).toBe(n);
  });

  it("known-bad: someone on another team is 403 not_the_captain, one refusal row, and the code stays", () => {
    const code = sqlGet<{ code: string }>("SELECT invite_code AS code FROM teams WHERE id = ?", captain.teamId)!.code;
    const refusals = () => count("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused' AND target_type = 'team'");
    const n = refusals();
    expectHttpError(() => rotateInvite(actorById(otherTeamMember), captain.teamId), 403, "not_the_captain");
    expect(sqlGet<{ code: string }>("SELECT invite_code AS code FROM teams WHERE id = ?", captain.teamId)!.code).toBe(code);
    expect(refusals()).toBe(n + 1);
  });

  it("known-bad: no session is 401", () => {
    expectHttpError(() => rotateInvite(null, captain.teamId), 401, "unauthenticated");
  });
});
