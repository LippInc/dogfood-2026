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
import { createTeam, getTeamForOrganizer, joinTeam, renameTeam } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";

// A team's name: its members change it while submissions are open; after that only an
// organizer, with a reason the audit log keeps, until results are published.

const NOW = "2026-09-26T12:00:00.000Z";
const FIXTURE_CLOSE = "2026-03-01T18:00:00Z";

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

const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();
const lastAction = () => auditRows().at(-1)!;

function actorById(userId: string, isAdmin = false): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin, roles, sessionKind: "login" };
}

function addUser(id: string, email: string, name: string): Actor {
  h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(id, email, name, NOW);
  return actorById(id);
}

const openEvent = () => h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
const closeEvent = () => h.sqlite.prepare("UPDATE events SET submissions_close_at = ? WHERE id = 'evt_01'").run(FIXTURE_CLOSE);
const publish = () => h.sqlite.prepare("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'").run(NOW);
const nameOf = (teamId: string) => (h.sqlite.prepare("SELECT name FROM teams WHERE id = ?").get(teamId) as { name: string }).name;
const inviteCodeOf = (teamId: string) => (h.sqlite.prepare("SELECT invite_code AS c FROM teams WHERE id = ?").get(teamId) as { c: string }).c;
const org = () => actorById("usr_organizer");

/** A captain and a member on a new team, while submissions are open. */
function pair() {
  openEvent();
  addUser("usr_cap", "cap@example.org", "Cara Captain");
  addUser("usr_mem", "mem@example.org", "Mo Member");
  const teamId = createTeam(actorById("usr_cap"), "evt_01", { name: "Typo Tema" }).id;
  joinTeam(actorById("usr_mem"), inviteCodeOf(teamId));
  return { teamId, captain: actorById("usr_cap"), member: actorById("usr_mem") };
}

describe("a member renames the team while submissions are open", () => {
  it("any member, not only the captain: the name changes and one team.renamed row keeps both names; the same name again writes nothing", () => {
    const { teamId, member } = pair();
    expect(renameTeam(member, teamId, { name: "  Typo Team " })).toEqual({ teamId, name: "Typo Team" });
    expect(nameOf(teamId)).toBe("Typo Team");
    expect(lastAction()).toMatchObject({ action: "team.renamed", targetId: teamId, before: { name: "Typo Tema" }, after: { name: "Typo Team" } });
    const rows = auditRows().length;
    renameTeam(member, teamId, { name: "Typo Team" });
    expect(auditRows().length).toBe(rows);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("known-bad: an empty or 61-character name is 422 and the name stays", () => {
    const { teamId, captain } = pair();
    expectHttpError(() => renameTeam(captain, teamId, { name: "  " }), 422, "invalid");
    expectHttpError(() => renameTeam(captain, teamId, { name: "x".repeat(61) }), 422, "invalid");
    expect(nameOf(teamId)).toBe("Typo Tema");
  });

  it("known-bad: someone not on the team is 403 not_on_this_team (one refusal row); no session is 401", () => {
    const { teamId } = pair();
    const outsider = addUser("usr_out", "out@example.org", "Out Sider");
    expectHttpError(() => renameTeam(outsider, teamId, { name: "Mine Now" }), 403, "not_on_this_team");
    expect(lastAction()).toMatchObject({ action: "authz.refused" });
    expectHttpError(() => renameTeam(null, teamId, { name: "Mine Now" }), 401, "unauthenticated");
    expect(nameOf(teamId)).toBe("Typo Tema");
  });

  it("known-bad: once submissions close, a member is 403 submissions_closed", () => {
    const { teamId, member } = pair();
    closeEvent();
    expectHttpError(() => renameTeam(member, teamId, { name: "Too Late" }), 403, "submissions_closed");
    expect(nameOf(teamId)).toBe("Typo Tema");
  });
});

describe("an organizer renames a team, with a reason", () => {
  it("after the close: without a reason 422; with one the name changes and the row is team.renamed_by_organizer with the reason", () => {
    const { teamId } = pair();
    closeEvent();
    expectHttpError(() => renameTeam(org(), teamId, { name: "Typo Team" }), 422, "invalid");
    expectHttpError(() => renameTeam(org(), teamId, { name: "Typo Team", reason: "x" }), 422, "invalid");
    expect(nameOf(teamId)).toBe("Typo Tema");

    renameTeam(org(), teamId, { name: "Typo Team", reason: "The team asked by mail; a typo" });

    expect(nameOf(teamId)).toBe("Typo Team");
    expect(lastAction()).toMatchObject({
      action: "team.renamed_by_organizer",
      actorUserId: "usr_organizer",
      before: { name: "Typo Tema" },
      after: { name: "Typo Team", reason: "The team asked by mail; a typo" },
    });
  });

  it("a fixture team after the close (the real case): renamed with a reason; while submissions are open an organizer not on the team gives one too", () => {
    renameTeam(org(), "tm_01", { name: "Renamed Fixture Team", reason: "Offensive name, agreed with the team" });
    expect(nameOf("tm_01")).toBe("Renamed Fixture Team");
    openEvent();
    expectHttpError(() => renameTeam(org(), "tm_01", { name: "Again" }), 422, "invalid");
  });

  it("known-bad: once results are published the name is final (403 results_published), for organizers too", () => {
    publish();
    expectHttpError(() => renameTeam(org(), "tm_01", { name: "After The Fact", reason: "should not work" }), 403, "results_published");
    expect(nameOf("tm_01")).not.toBe("After The Fact");
  });

  it("known-bad: an administrator who does not run the event, and a judge, are refused", () => {
    closeEvent();
    const admin = addUser("usr_admin", "admin@example.org", "Ada Admin");
    expectHttpError(() => renameTeam({ ...admin, isAdmin: true }, "tm_01", { name: "Nope", reason: "not mine" }), 403, "not_on_this_team");
    const judge = actorById((h.sqlite.prepare("SELECT user_id AS u FROM user_roles WHERE role = 'judge' AND event_id = 'evt_01' LIMIT 1").get() as { u: string }).u);
    expectHttpError(() => renameTeam(judge, "tm_01", { name: "Nope", reason: "not mine" }), 403, "not_on_this_team");
  });
});

describe("the organizer's team page data", () => {
  it("an organizer sees members with their addresses and the team's history with the reason; a participant is 403; another event's team is 404", () => {
    renameTeam(org(), "tm_01", { name: "Clearer Name", reason: "Two teams had the same name" });
    const view = getTeamForOrganizer(org(), "evt_01", "tm_01");
    expect(view.team.name).toBe("Clearer Name");
    expect(view.members.length).toBeGreaterThan(0);
    expect(view.members.every((m) => m.email.includes("@"))).toBe(true);
    expect(view.canChange).toBe(true);
    const renamed = view.history.find((l) => l.action === "team.renamed_by_organizer");
    expect(renamed?.parts.map((p) => p.text).join("")).toContain("Two teams had the same name");

    const participant = actorById((h.sqlite.prepare("SELECT user_id AS u FROM team_members WHERE team_id = 'tm_02' LIMIT 1").get() as { u: string }).u);
    expectHttpError(() => getTeamForOrganizer(participant, "evt_01", "tm_01"), 403, "not_an_organizer");
    expectHttpError(() => getTeamForOrganizer(org(), "evt_01", "tm_nope"), 404, "not_found");
    publish();
    expect(getTeamForOrganizer(org(), "evt_01", "tm_01").canChange).toBe(false);
  });
});
