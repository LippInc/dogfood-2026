import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { createTeam, dissolveTeam, inviteByCode, joinTeam, leaveTeam, makeCaptain, removeMember, rotateInvite } from "@/server/dal/teams";
import { createProject } from "@/server/dal/projects";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";
const FIXTURE_CLOSE = "2026-03-01T18:00:00Z"; // the fixture event's own submissions_close

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the team DAL goes through getDb()
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

const userIdByEmail = (email: string) =>
  (h.sqlite.prepare("SELECT id FROM users WHERE id = (SELECT id FROM users WHERE email = ?)").get(email) as { id: string }).id;

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as
    | { id: string; name: string; email: string }
    | undefined;
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = h.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

function addUser(id: string, email: string, name: string): Actor {
  h.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)")
    .run(id, email, name, NOW);
  return actorById(id);
}

const openEvent = () =>
  h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
const closeEvent = () =>
  h.sqlite.prepare("UPDATE events SET submissions_close_at = ? WHERE id = 'evt_01'").run(FIXTURE_CLOSE);

const inviteCodeOf = (teamId: string) =>
  (h.sqlite.prepare("SELECT invite_code AS c FROM teams WHERE id = ?").get(teamId) as { c: string }).c;
const memberCount = (teamId: string) =>
  (h.sqlite.prepare("SELECT count(*) AS n FROM team_members WHERE team_id = ?").get(teamId) as { n: number }).n;
const roleIn = (teamId: string, userId: string) =>
  (h.sqlite.prepare("SELECT role FROM team_members WHERE team_id = ? AND user_id = ?").get(teamId, userId) as
    | { role: string }
    | undefined)?.role;
const hasParticipantRole = (userId: string) =>
  Boolean(
    h.sqlite
      .prepare("SELECT 1 AS x FROM user_roles WHERE user_id = ? AND event_id = 'evt_01' AND role = 'participant'")
      .get(userId),
  );

describe("createTeam", () => {
  it("refuses a missing session with 401 and writes no audit row", () => {
    const before = auditRows().length;
    expectHttpError(() => createTeam(null, "evt_01", { name: "X" }), 401, "unauthenticated");
    expect(auditRows().length).toBe(before);
  });

  describe("the fixture event is closed (its close date is in the past)", () => {
    it("refuses a brand-new user with 403 submissions_closed: no team row, exactly one authz.refused audit row", () => {
      const outsider = addUser("usr_newbie", "newbie@example.org", "Newbie");
      const teamsBefore = count("SELECT count(*) AS n FROM teams");
      const before = auditRows().length;

      expectHttpError(() => createTeam(outsider, "evt_01", { name: "X" }), 403, "submissions_closed");

      expect(count("SELECT count(*) AS n FROM teams")).toBe(teamsBefore);
      const rows = auditRows();
      expect(rows).toHaveLength(before + 1); // the refusal is the only new row
      const refusals = rows.filter((r) => r.action === "authz.refused");
      expect(refusals).toHaveLength(1);
      expect(JSON.stringify(refusals[0]!.after)).toContain('"code":"submissions_closed"');
      expect(refusals[0]!.eventId).toBe("evt_01");
    });
  });

  describe("while submissions are open", () => {
    beforeEach(() => {
      openEvent();
    });

    it("creates the team trimmed, with the creator as captain, the participant role, one audit row, chain intact", () => {
      const captain = addUser("usr_founder", "founder@example.org", "Founder");

      const team = createTeam(captain, "evt_01", { name: "  Night Owls " });

      expect(team.id.startsWith("tm_")).toBe(true);
      expect(team.name).toBe("Night Owls");
      expect(team.eventId).toBe("evt_01");
      expect(roleIn(team.id, captain.userId)).toBe("captain");
      expect(hasParticipantRole(captain.userId)).toBe(true);

      const creates = auditRows().filter((r) => r.action === "team.create");
      expect(creates).toHaveLength(1);
      expect(creates[0]!.targetId).toBe(team.id);
      expect(creates[0]!.eventId).toBe("evt_01");
      expect(verifyAuditChain(h.db).ok).toBe(true);
    });

    it("refuses a second team for the same user, and a fixture member, with 403 already_on_a_team", () => {
      const captain = addUser("usr_founder", "founder@example.org", "Founder");
      createTeam(captain, "evt_01", { name: "Night Owls" });
      expectHttpError(() => createTeam(captain, "evt_01", { name: "Second" }), 403, "already_on_a_team");

      const fixtureMember = actorById(userIdByEmail("member1_1@example.org")); // on tm_01
      expectHttpError(() => createTeam(fixtureMember, "evt_01", { name: "Also Second" }), 403, "already_on_a_team");
    });

    it("known-bad: an empty name is 422 and leaves no team row and no audit row", () => {
      const u = addUser("usr_named", "named@example.org", "Named");
      const teamsBefore = count("SELECT count(*) AS n FROM teams");
      const before = auditRows().length;

      expectHttpError(() => createTeam(u, "evt_01", { name: "" }), 422, "invalid");

      expect(count("SELECT count(*) AS n FROM teams")).toBe(teamsBefore);
      expect(auditRows().length).toBe(before);
    });
  });
});

describe("joinTeam", () => {
  describe("while submissions are open", () => {
    beforeEach(() => {
      openEvent();
    });

    function teamOfTwo() {
      const captain = addUser("usr_cap", "captain@example.org", "Captain");
      const team = createTeam(captain, "evt_01", { name: "Night Owls" });
      const joiner = addUser("usr_joiner", "joiner@example.org", "Joiner");
      return { captain, joiner, teamId: team.id, code: inviteCodeOf(team.id) };
    }

    it("known-bad: a judge assigned to a team's project cannot join that team (403 conflict_of_interest); after declaring the conflict they can", () => {
      // a fixture team with room for two more, a judge assigned to its project and one who is not
      const { teamId } = h.sqlite
        .prepare(
          "SELECT t.id AS teamId FROM teams t JOIN projects p ON p.team_id = t.id WHERE t.event_id = 'evt_01' AND (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) <= 2 ORDER BY t.id LIMIT 1",
        )
        .get() as { teamId: string };
      const assigned = (
        h.sqlite
          .prepare("SELECT a.id AS id, a.judge_user_id AS judge FROM assignments a JOIN projects p ON p.id = a.project_id WHERE p.team_id = ? LIMIT 1")
          .get(teamId) as { id: string; judge: string }
      );
      const other = (
        h.sqlite
          .prepare(
            "SELECT DISTINCT a.judge_user_id AS judge FROM assignments a WHERE a.event_id = 'evt_01' AND a.judge_user_id NOT IN (SELECT a2.judge_user_id FROM assignments a2 JOIN projects p ON p.id = a2.project_id WHERE p.team_id = ?) LIMIT 1",
          )
          .get(teamId) as { judge: string }
      ).judge;
      const code = inviteCodeOf(teamId);
      const members = memberCount(teamId);
      const refusedBefore = auditRows().filter((r) => r.action === "authz.refused").length;

      expectHttpError(() => joinTeam(actorById(assigned.judge), code), 403, "conflict_of_interest");
      expect(memberCount(teamId)).toBe(members);
      expect(auditRows().filter((r) => r.action === "authz.refused")).toHaveLength(refusedBefore + 1);

      // positive controls: a judge with no assignment on this team joins; the assigned one after recusing
      expect(joinTeam(actorById(other), code).teamId).toBe(teamId);
      h.sqlite.prepare("UPDATE assignments SET status = 'recused' WHERE id = ?").run(assigned.id);
      expect(joinTeam(actorById(assigned.judge), code).teamId).toBe(teamId);
      expect(memberCount(teamId)).toBe(members + 2);
    });

    it("refuses an unknown code with 404", () => {
      const u = addUser("usr_lost", "lost@example.org", "Lost");
      expectHttpError(() => joinTeam(u, "nope"), 404, "not_found");
    });

    it("adds a second person as a member with the participant role and the event slug", () => {
      const { joiner, teamId, code } = teamOfTwo();

      const joined = joinTeam(joiner, code);

      expect(joined.teamId).toBe(teamId);
      expect(joined.eventSlug).toBe("sample-hack-2026");
      expect(roleIn(teamId, joiner.userId)).toBe("member");
      expect(hasParticipantRole(joiner.userId)).toBe(true);
      expect(memberCount(teamId)).toBe(2);
    });

    it("refuses the captain joining their own team again with 403 already_on_a_team", () => {
      const { captain, code } = teamOfTwo();
      expectHttpError(() => joinTeam(captain, code), 403, "already_on_a_team");
    });

    it("known-bad: a third joiner on a team at the event's maxTeamSize gets 409 team_full", () => {
      const { joiner, teamId, code } = teamOfTwo();
      joinTeam(joiner, code); // the team now has its two members
      h.sqlite.prepare(`UPDATE events SET settings = '{"maxTeamSize":2}' WHERE id = 'evt_01'`).run();

      const third = addUser("usr_third", "third@example.org", "Third");
      expectHttpError(() => joinTeam(third, code), 409, "team_full");
      expect(memberCount(teamId)).toBe(2); // unchanged
    });

    it("known-bad: joining after submissions close again is 403 submissions_closed and changes nothing", () => {
      const { teamId, code } = teamOfTwo();
      closeEvent();
      const before = memberCount(teamId);

      const late = addUser("usr_late", "late@example.org", "Late");
      expectHttpError(() => joinTeam(late, code), 403, "submissions_closed");
      expect(memberCount(teamId)).toBe(before);
    });
  });
});

describe("rotateInvite", () => {
  describe("while submissions are open", () => {
    beforeEach(() => {
      openEvent();
    });

    it("refuses a plain member with 403 not_the_captain", () => {
      const captain = addUser("usr_cap", "captain@example.org", "Captain");
      const team = createTeam(captain, "evt_01", { name: "Night Owls" });
      const joiner = addUser("usr_joiner", "joiner@example.org", "Joiner");
      joinTeam(joiner, inviteCodeOf(team.id));

      expectHttpError(() => rotateInvite(joiner, team.id), 403, "not_the_captain");
    });

    it("gives the captain a new code; the old code stops resolving, the new one returns the team", () => {
      const captain = addUser("usr_cap", "captain@example.org", "Captain");
      const team = createTeam(captain, "evt_01", { name: "Night Owls" });
      const joiner = addUser("usr_joiner", "joiner@example.org", "Joiner");
      joinTeam(joiner, inviteCodeOf(team.id));
      const oldCode = inviteCodeOf(team.id);

      const { inviteCode: newCode } = rotateInvite(captain, team.id);

      expect(newCode).not.toBe(oldCode);
      expect(inviteCodeOf(team.id)).toBe(newCode); // stored
      expectHttpError(() => inviteByCode(oldCode), 404, "not_found");
      const view = inviteByCode(newCode);
      expect(view.teamId).toBe(team.id);
      expect(view.members).toBe(2);
    });
  });
});

describe("leaving a team, taking a member off, handing the captaincy over", () => {
  beforeEach(() => {
    openEvent();
  });

  /** A captain and two members, all new people, on one new team. */
  function teamOfThree() {
    const captain = addUser("usr_cap", "cap@example.org", "Cara Captain");
    const a = addUser("usr_a", "a@example.org", "Avi Member");
    const b = addUser("usr_b", "b@example.org", "Bo Member");
    const teamId = createTeam(captain, "evt_01", { name: "Three Of Us" }).id;
    joinTeam(a, inviteCodeOf(teamId));
    joinTeam(b, inviteCodeOf(teamId));
    return { teamId, captain: actorById("usr_cap"), a: actorById("usr_a"), b: actorById("usr_b") };
  }
  const lastAction = () => auditRows().at(-1)!;

  it("a member leaves: off the team, still a participant, one team.left row; they can then start another team", () => {
    const { teamId, a } = teamOfThree();
    leaveTeam(a, teamId);
    expect(roleIn(teamId, a.userId)).toBeUndefined();
    expect(memberCount(teamId)).toBe(2);
    expect(hasParticipantRole(a.userId)).toBe(true);
    expect(lastAction().action).toBe("team.left");
    expect(createTeam(actorById(a.userId), "evt_01", { name: "Solo Now" }).id).toBeTruthy();
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("known-bad: the captain cannot leave while others are on the team (409), the last member never (409), and an outsider is 403", () => {
    const { teamId, captain } = teamOfThree();
    expectHttpError(() => leaveTeam(captain, teamId), 409, "captain_hands_over_first");
    const outsider = addUser("usr_out", "out@example.org", "Out Sider");
    expectHttpError(() => leaveTeam(outsider, teamId), 403, "not_on_this_team");
    const solo = addUser("usr_solo", "solo@example.org", "Solo Captain");
    const soloTeam = createTeam(solo, "evt_01", { name: "Just Me" }).id;
    expectHttpError(() => leaveTeam(actorById("usr_solo"), soloTeam), 409, "last_member");
    expect(memberCount(teamId)).toBe(3);
    expect(memberCount(soloTeam)).toBe(1);
  });

  it("the captain takes a member off (team.member_removed); a member cannot (403), nor can the captain remove themselves (409)", () => {
    const { teamId, captain, a, b } = teamOfThree();
    expectHttpError(() => removeMember(a, teamId, b.userId), 403, "not_the_captain");
    expectHttpError(() => removeMember(captain, teamId, captain.userId), 409, "cannot_remove_yourself");
    removeMember(captain, teamId, b.userId);
    expect(roleIn(teamId, b.userId)).toBeUndefined();
    expect(lastAction().action).toBe("team.member_removed");
    expect(lastAction().before).toEqual({ member: b.userId });
    expectHttpError(() => removeMember(captain, teamId, b.userId), 404, "not_found");
  });

  it("the captain hands the captaincy over: the roles swap, one team.captain_changed row, and the old captain may then leave", () => {
    const { teamId, captain, a } = teamOfThree();
    expectHttpError(() => makeCaptain(a, teamId, { userId: a.userId }), 403, "not_the_captain");
    makeCaptain(captain, teamId, { userId: a.userId });
    expect(roleIn(teamId, a.userId)).toBe("captain");
    expect(roleIn(teamId, captain.userId)).toBe("member");
    expect(lastAction()).toMatchObject({ action: "team.captain_changed", before: { captain: captain.userId }, after: { captain: a.userId } });
    leaveTeam(actorById(captain.userId), teamId);
    expect(roleIn(teamId, captain.userId)).toBeUndefined();
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM team_members WHERE team_id = ? AND role = 'captain'").get(teamId)).toEqual({ n: 1 });
  });

  describe("the last member dissolves the team", () => {
    const teamRow = (teamId: string) => h.sqlite.prepare("SELECT id FROM teams WHERE id = ?").get(teamId);
    const projectRow = (projectId: string) => h.sqlite.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);

    it("a team started by mistake: its only member dissolves it (one team.dissolved row naming it) and can then join the friend's team", () => {
      const solo = addUser("usr_solo", "solo@example.org", "Solo Captain");
      const mistake = createTeam(solo, "evt_01", { name: "Oops Team" }).id;
      const friend = addUser("usr_friend", "friend@example.org", "Friend");
      const meant = createTeam(friend, "evt_01", { name: "Meant Team" }).id;
      // the dead end this fixes: joining is refused while on a team, leaving is refused for the last member
      expectHttpError(() => joinTeam(actorById("usr_solo"), inviteCodeOf(meant)), 403, "already_on_a_team");
      expectHttpError(() => leaveTeam(actorById("usr_solo"), mistake), 409, "last_member");

      const out = dissolveTeam(actorById("usr_solo"), mistake);

      expect(out).toEqual({ teamId: mistake, draftDeleted: null });
      expect(teamRow(mistake)).toBeUndefined();
      expect(memberCount(mistake)).toBe(0);
      expect(lastAction()).toMatchObject({ action: "team.dissolved", targetId: mistake, before: { name: "Oops Team", member: "usr_solo", draft: null } });
      expect(hasParticipantRole("usr_solo")).toBe(true);
      expect(joinTeam(actorById("usr_solo"), inviteCodeOf(meant)).teamId).toBe(meant);
      expect(verifyAuditChain(h.db).ok).toBe(true);
    });

    it("a draft project goes with the team, its custom answers too, and the audit row keeps its id and title", () => {
      const solo = addUser("usr_solo", "solo@example.org", "Solo Captain");
      const teamId = createTeam(solo, "evt_01", { name: "Draft Team" }).id;
      const draft = createProject(actorById("usr_solo"), "evt_01", { title: "Half Done", trackId: "trk_01", status: "draft" });
      h.sqlite.prepare("INSERT INTO custom_questions (id, event_id, label) VALUES ('q_team', 'evt_01', 'Who did what?')").run();
      h.sqlite.prepare("INSERT INTO custom_answers (project_id, question_id, value) VALUES (?, 'q_team', 'x')").run(draft.id);
      expect(count(`SELECT count(*) AS n FROM custom_answers WHERE project_id = '${draft.id}'`)).toBe(1);

      dissolveTeam(actorById("usr_solo"), teamId);

      expect(projectRow(draft.id)).toBeUndefined();
      expect(count(`SELECT count(*) AS n FROM custom_answers WHERE project_id = '${draft.id}'`)).toBe(0);
      expect(teamRow(teamId)).toBeUndefined();
      expect(lastAction()).toMatchObject({ action: "team.dissolved", before: { draft: { id: draft.id, title: "Half Done" } } });
    });

    it("known-bad: a submitted project keeps its team (409 project_submitted); a draft already in the judging too (409 project_in_use); nothing changes", () => {
      const solo = addUser("usr_solo", "solo@example.org", "Solo Captain");
      const teamId = createTeam(solo, "evt_01", { name: "Handed In" }).id;
      const p = createProject(actorById("usr_solo"), "evt_01", { title: "Done", trackId: "trk_01", status: "draft" });
      h.sqlite.prepare("UPDATE projects SET status = 'submitted', submitted_at = ? WHERE id = ?").run(NOW, p.id);
      const before = auditRows().length;
      expectHttpError(() => dissolveTeam(actorById("usr_solo"), teamId), 409, "project_submitted");
      expect(teamRow(teamId)).toBeDefined();
      expect(projectRow(p.id)).toBeDefined();
      expect(auditRows().length).toBe(before);

      // back to a draft that someone has already commented on (by hand: the app never lets that happen)
      h.sqlite.prepare("UPDATE projects SET status = 'draft', submitted_at = NULL WHERE id = ?").run(p.id);
      h.sqlite
        .prepare("INSERT INTO comments (id, event_id, project_id, user_id, body, created_at) VALUES ('cmt_x', 'evt_01', ?, 'usr_solo', 'hi', ?)")
        .run(p.id, NOW);
      expectHttpError(() => dissolveTeam(actorById("usr_solo"), teamId), 409, "project_in_use");
      expect(teamRow(teamId)).toBeDefined();
      expect(projectRow(p.id)).toBeDefined();
    });

    it("known-bad: with others on the team it is 409 others_on_the_team; an outsider is 403 not_on_this_team; after the close 403 submissions_closed", () => {
      const { teamId, captain } = teamOfThree();
      expectHttpError(() => dissolveTeam(captain, teamId), 409, "others_on_the_team");
      const outsider = addUser("usr_out", "out@example.org", "Out Sider");
      expectHttpError(() => dissolveTeam(outsider, teamId), 403, "not_on_this_team");
      expect(memberCount(teamId)).toBe(3);

      const solo = addUser("usr_solo", "solo@example.org", "Solo Captain");
      const soloTeam = createTeam(solo, "evt_01", { name: "Just Me" }).id;
      closeEvent();
      expectHttpError(() => dissolveTeam(actorById("usr_solo"), soloTeam), 403, "submissions_closed");
      expect(teamRow(soloTeam)).toBeDefined();
      expect(auditRows().at(-1)!.action).toBe("authz.refused");
    });
  });

  it("known-bad: once submissions close, leaving, taking off and handing over are 403 submissions_closed and nothing changes", () => {
    const { teamId, captain, a, b } = teamOfThree();
    closeEvent();
    expectHttpError(() => leaveTeam(a, teamId), 403, "submissions_closed");
    expectHttpError(() => removeMember(captain, teamId, b.userId), 403, "submissions_closed");
    expectHttpError(() => makeCaptain(captain, teamId, { userId: a.userId }), 403, "submissions_closed");
    expect(memberCount(teamId)).toBe(3);
    expect(roleIn(teamId, captain.userId)).toBe("captain");
  });
});
