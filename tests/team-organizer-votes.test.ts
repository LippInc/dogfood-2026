import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { organizerAddMember, organizerRemoveMember } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";

// The community count skips a member's votes for their own team. An organizer's team change
// after the close must never move that count quietly: adding someone who voted for the team's
// project would drop a counted vote, and taking off a member who voted for it would start
// counting one. Both are refused (409 vote_would_change) until the vote is voided, which is its
// own audited step. The fixture event is closed (its close date is past).

const NOW = "2026-09-26T12:00:00.000Z";
const reason = "Left off by mistake; the team confirmed by mail";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
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

const org = () => actorById("usr_organizer");
const members = (teamId: string) => (h.sqlite.prepare("SELECT user_id AS u FROM team_members WHERE team_id = ? ORDER BY joined_at, user_id").all(teamId) as { u: string }[]).map((m) => m.u);
const projectOf = (teamId: string) => (h.sqlite.prepare("SELECT id FROM projects WHERE team_id = ? AND status = 'submitted'").get(teamId) as { id: string }).id;

function addUser(id: string, email: string, name: string) {
  h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(id, email, name, NOW);
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
const voidVoter = (id: string) => h.sqlite.prepare("UPDATE voters SET voided_at = ?, voided_by = 'usr_organizer', void_reason = 'duplicate person' WHERE id = ?").run(NOW, id);

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

describe("an organizer's team change never moves the community vote count", () => {
  it("known-bad: adding someone with an account vote for the team's project is 409 vote_would_change; nothing changes", () => {
    addUser("usr_late", "late@example.org", "Lee Late");
    accountVote("usr_late", projectOf("tm_02"));
    const before = members("tm_02");
    expectConflict(() => organizerAddMember(org(), "tm_02", { email: "late@example.org", reason }), "vote_would_change");
    expect(members("tm_02")).toEqual(before);
  });

  it("known-bad: a listed voter's address that belongs to the account counts as that person too", () => {
    addUser("usr_late", "late@example.org", "Lee Late");
    listedVote("late@example.org", projectOf("tm_02"));
    expectConflict(() => organizerAddMember(org(), "tm_02", { email: "late@example.org", reason }), "vote_would_change");
  });

  it("positive controls: a vote for another team's project, or a voided vote, does not stop the add", () => {
    addUser("usr_late", "late@example.org", "Lee Late");
    accountVote("usr_late", projectOf("tm_03"));
    expect(organizerAddMember(org(), "tm_02", { email: "late@example.org", reason })).toMatchObject({ teamId: "tm_02", added: "usr_late" });

    addUser("usr_late2", "late2@example.org", "Lou Later");
    const v = accountVote("usr_late2", projectOf("tm_04"));
    voidVoter(v);
    expect(organizerAddMember(org(), "tm_04", { email: "late2@example.org", reason })).toMatchObject({ teamId: "tm_04", added: "usr_late2" });
  });

  it("known-bad: taking off a member who voted for their own team's project is 409 vote_would_change; after voiding it goes through", () => {
    const [, second] = members("tm_01");
    const v = accountVote(second!, projectOf("tm_01"));
    expectConflict(() => organizerRemoveMember(org(), "tm_01", second!, { reason }), "vote_would_change");
    expect(members("tm_01")).toContain(second);
    voidVoter(v);
    expect(organizerRemoveMember(org(), "tm_01", second!, { reason })).toMatchObject({ teamId: "tm_01", removed: second });
    expect(members("tm_01")).not.toContain(second);
  });
});
