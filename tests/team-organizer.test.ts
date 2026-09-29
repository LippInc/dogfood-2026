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
import { getPublicProject } from "@/server/dal/projects";
import { joinTeam, organizerAddMember, organizerRemoveMember, renameTeam } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";
import { withDetail } from "@/lib/format";

// Teams are fixed when submissions close, and certificates go to their members. Until results
// are published an organizer can put someone back on a team or take someone off, with a
// written reason; the change is audited, and the public project page says the organizers
// changed the team after the close. The fixture event is closed (its close date is past).

const NOW = "2026-09-26T12:00:00.000Z";

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
  return error;
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

const org = () => actorById("usr_organizer");
const members = (teamId: string) =>
  h.sqlite.prepare("SELECT user_id AS u, role FROM team_members WHERE team_id = ? ORDER BY joined_at, user_id").all(teamId) as { u: string; role: string }[];
const projectOf = (teamId: string) => (h.sqlite.prepare("SELECT id FROM projects WHERE team_id = ? AND status = 'submitted'").get(teamId) as { id: string }).id;
const publish = () => h.sqlite.prepare("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'").run(NOW);
const reason = "Left off by mistake; the team confirmed by mail";

describe("an organizer puts someone on a team after the close", () => {
  it("known-bad before the fix: the team itself cannot (403 submissions_closed); the organizer can, with one audited row, and the project page says so", () => {
    const late = addUser("usr_late", "late@example.org", "Lee Late");
    const project = projectOf("tm_02");
    expect(getPublicProject("evt_01", project).project.team.changedByOrganizersAt).toBeNull();
    const code = (h.sqlite.prepare("SELECT invite_code AS c FROM teams WHERE id = 'tm_02'").get() as { c: string }).c;
    expectHttpError(() => joinTeam(late, code), 403, "submissions_closed");

    const out = organizerAddMember(org(), "tm_02", { email: "  LATE@example.org ", reason });

    expect(out).toEqual({ teamId: "tm_02", added: late.userId });
    expect(members("tm_02").find((m) => m.u === late.userId)?.role).toBe("member");
    expect(actorById(late.userId).roles).toContainEqual({ eventId: "evt_01", role: "participant" });
    expect(lastAction()).toMatchObject({ action: "team.member_added_by_organizer", actorUserId: "usr_organizer", targetId: "tm_02", after: { member: late.userId, reason } });
    const shown = getPublicProject("evt_01", project).project.team;
    expect(shown.members).toBe(3);
    expect(shown.changedByOrganizersAt).toBe(lastAction().at);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("known-bad: no reason or a one-letter one is 422; an address with no account is 422 on the email field; nothing changes", () => {
    addUser("usr_late", "late@example.org", "Lee Late");
    const before = members("tm_02").length;
    expectHttpError(() => organizerAddMember(org(), "tm_02", { email: "late@example.org" }), 422, "invalid");
    expectHttpError(() => organizerAddMember(org(), "tm_02", { email: "late@example.org", reason: "x" }), 422, "invalid");
    const e = expectHttpError(() => organizerAddMember(org(), "tm_02", { email: "nobody@example.org", reason }), 422, "invalid");
    expect(e.details).toHaveProperty("email");
    expect(members("tm_02").length).toBe(before);
  });

  it("an address with no account reads as one sentence on the form, not the same thing twice", () => {
    const e = expectHttpError(() => organizerAddMember(org(), "tm_02", { email: "nobody@example.org", reason }), 422, "invalid");
    const line = withDetail(e.message, (e.details as Record<string, string[]>).email?.[0]);
    expect(line).toBe("No account has that address: they sign up first, then you add them.");
    // the helper still adds a detail the message does not say, as the other refusals on the form need
    expect(withDetail("Check the highlighted fields.", "say why, in a few words")).toBe("Check the highlighted fields. say why, in a few words");
  });

  it("known-bad: the join rules hold: one team per person (409 already_on_a_team / already_on_this_team), the team size (409 team_full), no judge of the project (409 conflict_of_interest)", () => {
    const onTm01 = members("tm_01")[0]!.u;
    const onTm02 = members("tm_02")[0]!.u;
    const email = (u: string) => (h.sqlite.prepare("SELECT email FROM users WHERE id = ?").get(u) as { email: string }).email;
    expectHttpError(() => organizerAddMember(org(), "tm_02", { email: email(onTm01), reason }), 409, "already_on_a_team");
    expectHttpError(() => organizerAddMember(org(), "tm_02", { email: email(onTm02), reason }), 409, "already_on_this_team");

    addUser("usr_late", "late@example.org", "Lee Late");
    expectHttpError(() => organizerAddMember(org(), "tm_05", { email: "late@example.org", reason }), 409, "team_full"); // tm_05 has 4, the default most

    const judge = (
      h.sqlite.prepare("SELECT a.judge_user_id AS j FROM assignments a WHERE a.project_id = ? AND a.status != 'recused' LIMIT 1").get(projectOf("tm_02")) as { j: string }
    ).j;
    expectHttpError(() => organizerAddMember(org(), "tm_02", { email: email(judge), reason }), 409, "conflict_of_interest");
    expect(members("tm_02").length).toBe(2);
  });

  it("known-bad: a participant, the team's own captain, and an administrator who does not run the event are 403 not_an_organizer; no session is 401", () => {
    addUser("usr_late", "late@example.org", "Lee Late");
    const captain = actorById(members("tm_02").find((m) => m.role === "captain")!.u);
    expectHttpError(() => organizerAddMember(captain, "tm_02", { email: "late@example.org", reason }), 403, "not_an_organizer");
    const admin = addUser("usr_admin", "admin@example.org", "Ada Admin");
    expectHttpError(() => organizerAddMember({ ...admin, isAdmin: true }, "tm_02", { email: "late@example.org", reason }), 403, "not_an_organizer");
    expectHttpError(() => organizerAddMember(null, "tm_02", { email: "late@example.org", reason }), 401, "unauthenticated");
    expect(members("tm_02").length).toBe(2);
    expect(lastAction().action).toBe("authz.refused");
  });

  it("known-bad: once results are published the team is final: adding and taking off are 403 results_published", () => {
    addUser("usr_late", "late@example.org", "Lee Late");
    publish();
    expectHttpError(() => organizerAddMember(org(), "tm_02", { email: "late@example.org", reason }), 403, "results_published");
    expectHttpError(() => organizerRemoveMember(org(), "tm_01", members("tm_01")[1]!.u, { reason }), 403, "results_published");
    expect(members("tm_01").length).toBe(3);
  });
});

describe("an organizer takes someone off a team", () => {
  it("with a reason: one team.member_removed_by_organizer row; taking the captain off makes the member who joined first captain", () => {
    const [first, second, third] = members("tm_01");
    const captain = [first, second, third].find((m) => m!.role === "captain")!;
    const rest = members("tm_01").filter((m) => m.u !== captain.u);

    const out = organizerRemoveMember(org(), "tm_01", captain.u, { reason: "Asked to be taken off: not part of the build" });

    expect(out.captain).toBe(rest[0]!.u);
    expect(members("tm_01").map((m) => m.u)).toEqual(rest.map((m) => m.u));
    expect(members("tm_01").filter((m) => m.role === "captain").map((m) => m.u)).toEqual([rest[0]!.u]);
    expect(lastAction()).toMatchObject({
      action: "team.member_removed_by_organizer",
      before: { member: captain.u, role: "captain" },
      after: { reason: "Asked to be taken off: not part of the build", captain: rest[0]!.u },
    });
  });

  it("known-bad: the last member stays (409 last_member); someone not on the team is 404; no reason is 422", () => {
    const only = members("tm_04")[0]!.u;
    expectHttpError(() => organizerRemoveMember(org(), "tm_04", only, { reason }), 409, "last_member");
    expectHttpError(() => organizerRemoveMember(org(), "tm_04", "usr_organizer", { reason }), 404, "not_found");
    expectHttpError(() => organizerRemoveMember(org(), "tm_01", members("tm_01")[1]!.u, {}), 422, "invalid");
    expect(members("tm_04")).toHaveLength(1);
    expect(members("tm_01")).toHaveLength(3);
  });

  it("the project page says nothing for changes made while submissions were open", () => {
    h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
    renameTeam(org(), "tm_02", { name: "Early Rename", reason: "The team asked on the first day" });
    expect(getPublicProject("evt_01", projectOf("tm_02")).project.team.changedByOrganizersAt).toBeNull();
  });
});
