import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { joinTeam, leaveTeam, removeMember } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";

// The community count skips a member's votes for their own team. The organizer's team changes
// already refuse a change that would move that count (team-organizer-votes.test.ts); a member's
// own join and leave, and a captain taking a member off, follow the same rule. It matters when a
// voting window overlaps open submissions: someone who voted for a team and then joins it takes
// the vote out of the count, and leaving again would start counting it.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  // submissions open, room on every team
  h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z', settings = json_set(settings, '$.maxTeamSize', 20) WHERE id = 'evt_01'").run();
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

const members = (teamId: string) =>
  (h.sqlite.prepare("SELECT user_id AS u, role AS r FROM team_members WHERE team_id = ? ORDER BY joined_at, user_id").all(teamId) as { u: string; r: string }[]);
const plainMember = (teamId: string) => members(teamId).find((m) => m.r !== "captain")!.u;
const captainOf = (teamId: string) => members(teamId).find((m) => m.r === "captain")!.u;
const projectOf = (teamId: string) => (h.sqlite.prepare("SELECT id FROM projects WHERE team_id = ? AND status = 'submitted'").get(teamId) as { id: string }).id;
const codeOf = (teamId: string) => (h.sqlite.prepare("SELECT invite_code AS c FROM teams WHERE id = ?").get(teamId) as { c: string }).c;

function addUser(id: string, email: string, name: string) {
  h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(id, email, name, NOW);
  return actorById(id);
}

let seq = 0;
function accountVote(userId: string, projectId: string) {
  const id = `vtr_test_${++seq}`;
  h.sqlite.prepare("INSERT INTO voters (id, event_id, kind, user_id, order_seed, created_at) VALUES (?, 'evt_01', 'account', ?, 1, ?)").run(id, userId, NOW);
  h.sqlite.prepare("INSERT INTO votes (voter_id, project_id, created_at) VALUES (?, ?, ?)").run(id, projectId, NOW);
  return id;
}
function listedVote(email: string, projectId: string) {
  const id = `vtr_test_${++seq}`;
  h.sqlite.prepare("INSERT INTO voters (id, event_id, kind, email, token_hash, order_seed, created_at) VALUES (?, 'evt_01', 'listed', ?, ?, 1, ?)").run(id, email, `hash_${id}`, NOW);
  h.sqlite.prepare("INSERT INTO votes (voter_id, project_id, created_at) VALUES (?, ?, ?)").run(id, projectId, NOW);
  return id;
}
const voidVoter = (id: string) => h.sqlite.prepare("UPDATE voters SET voided_at = ?, voided_by = 'usr_organizer', void_reason = 'asked to' WHERE id = ?").run(NOW, id);
const dropVotes = (id: string) => h.sqlite.prepare("DELETE FROM votes WHERE voter_id = ?").run(id);

function expectConflict(call: () => unknown, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(409);
  expect((caught as HttpError).code).toBe(code);
}

describe("joining a team never moves the community vote count", () => {
  it("known-bad: joining the team whose project you voted for is 409 vote_would_change; you stay off it", () => {
    const u = addUser("usr_fan", "fan@example.org", "Fay Fan");
    accountVote(u.userId, projectOf("tm_02"));
    expectConflict(() => joinTeam(u, codeOf("tm_02")), "vote_would_change");
    expect(members("tm_02").map((m) => m.u)).not.toContain(u.userId);
  });

  it("known-bad: a listed voter's address that belongs to the account counts as that person too", () => {
    const u = addUser("usr_fan", "fan@example.org", "Fay Fan");
    listedVote("fan@example.org", projectOf("tm_02"));
    expectConflict(() => joinTeam(u, codeOf("tm_02")), "vote_would_change");
  });

  it("positive controls: a vote for another team's project, a voided vote, or a pick taken back does not stop the join", () => {
    const a = addUser("usr_a", "a@example.org", "Ann A");
    accountVote(a.userId, projectOf("tm_03"));
    expect(joinTeam(a, codeOf("tm_02")).teamId).toBe("tm_02");

    const b = addUser("usr_b", "b@example.org", "Bo B");
    voidVoter(accountVote(b.userId, projectOf("tm_04")));
    expect(joinTeam(b, codeOf("tm_04")).teamId).toBe("tm_04");

    const c = addUser("usr_c", "c@example.org", "Cy C");
    dropVotes(accountVote(c.userId, projectOf("tm_05")));
    expect(joinTeam(c, codeOf("tm_05")).teamId).toBe("tm_05");
  });
});

describe("leaving a team, or a captain taking a member off, never moves the community vote count", () => {
  it("known-bad: leaving the team you voted for (before you joined it) is 409 vote_would_change; after voiding it goes through", () => {
    const m = plainMember("tm_01");
    const v = accountVote(m, projectOf("tm_01"));
    expectConflict(() => leaveTeam(actorById(m), "tm_01"), "vote_would_change");
    expect(members("tm_01").map((x) => x.u)).toContain(m);
    voidVoter(v);
    expect(leaveTeam(actorById(m), "tm_01")).toMatchObject({ teamId: "tm_01" });
    expect(members("tm_01").map((x) => x.u)).not.toContain(m);
  });

  it("known-bad: the captain taking that member off is 409 vote_would_change too", () => {
    const m = plainMember("tm_01");
    accountVote(m, projectOf("tm_01"));
    expectConflict(() => removeMember(actorById(captainOf("tm_01")), "tm_01", m), "vote_would_change");
    expect(members("tm_01").map((x) => x.u)).toContain(m);
  });

  it("positive controls: a member whose vote is for another team leaves, and is taken off, as before", () => {
    const m = plainMember("tm_01");
    accountVote(m, projectOf("tm_02"));
    expect(leaveTeam(actorById(m), "tm_01")).toMatchObject({ teamId: "tm_01" });

    const n = plainMember("tm_03");
    accountVote(n, projectOf("tm_04"));
    expect(removeMember(actorById(captainOf("tm_03")), "tm_03", n)).toMatchObject({ teamId: "tm_03", removed: n });
  });
});
