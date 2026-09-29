import { describe, expect, it } from "vitest";
import { requireEvent } from "@/server/dal/events";
import { openFinals, setFinalsPanel } from "@/server/dal/finals";
import { organizerAddMember } from "@/server/dal/teams";
import { expectHttpError, organizer, sqlAll, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// A finals panelist judges every finalist of the round, so they cannot be put on a finalist's team, as a first-round
// judge cannot be put on the team of a project they judge: otherwise a team change would drop a finals score already
// given, even after the close (the finals lane's fourth review, finding 3).

const handle = withFixtureEvent();
const judges = () => sqlAll<{ id: string }>("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").map((r) => r.id);
const emailOf = (id: string) => sqlAll<{ email: string }>("SELECT email FROM users WHERE id = ?", id)[0]!.email;

function round() {
  requireEvent(handle().db, "evt_01");
  const opened = openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
  const [a, b] = judges().filter((j) => j !== "jdg_07");
  setFinalsPanel(organizer(), "evt_01", opened.id, { judges: [a!, b!] });
  const finalistTeam = sqlAll<{ team: string; project: string }>(
    "SELECT p.team_id AS team, p.id AS project FROM finalists f JOIN projects p ON p.id = f.project_id WHERE f.finals_id = ? ORDER BY p.id",
    opened.id,
  )[0]!;
  return { opened, a: a!, b: b!, finalistTeam };
}

describe("a finals panelist and a finalist's team", () => {
  it("an organizer cannot add a panelist to a finalist's team: 409 conflict_of_interest, nothing changes", () => {
    const { a, finalistTeam } = round();
    // take the panelist off every first-round assignment to this team's project, so only the finals rule is tested
    sqlRun("DELETE FROM assignments WHERE judge_user_id = ? AND project_id IN (SELECT id FROM projects WHERE team_id = ?)", a, finalistTeam.team);
    const before = sqlAll<{ n: number }>("SELECT count(*) AS n FROM team_members WHERE team_id = ?", finalistTeam.team)[0]!.n;
    expectHttpError(
      () => organizerAddMember(organizer(), finalistTeam.team, { email: emailOf(a), reason: "Joined the team late, by hand" }),
      409,
      "conflict_of_interest",
    );
    expect(sqlAll<{ n: number }>("SELECT count(*) AS n FROM team_members WHERE team_id = ?", finalistTeam.team)[0]!.n).toBe(before);
  });

  it("positive control: once off the panel, the same person is added", () => {
    const { opened, a, b, finalistTeam } = round();
    sqlRun("DELETE FROM assignments WHERE judge_user_id = ? AND project_id IN (SELECT id FROM projects WHERE team_id = ?)", a, finalistTeam.team);
    const others = judges().filter((j) => j !== "jdg_07" && j !== a && j !== b);
    setFinalsPanel(organizer(), "evt_01", opened.id, { judges: [b, others[0]!] });
    // no finals score exists yet, so the panel change needs no reason
    organizerAddMember(organizer(), finalistTeam.team, { email: emailOf(a), reason: "Joined the team late, by hand" });
    expect(sqlAll<{ n: number }>("SELECT count(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?", finalistTeam.team, a)[0]!.n).toBe(1);
  });
});
