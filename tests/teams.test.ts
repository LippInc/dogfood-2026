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
import { createTeam, inviteByCode, joinTeam, rotateInvite } from "@/server/dal/teams";
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
