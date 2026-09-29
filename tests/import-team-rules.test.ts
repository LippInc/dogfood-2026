import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");
const { exportFile } = await import("@/server/dal/exports");

// An import into an event that is already here keeps the rules the portal's own forms keep (the team pages, the
// project form, hand assignment): a team never grows past the event's size, a team has one project, and a judge
// never gets a project whose team they are on, from either side. A file that would break one is refused whole,
// 409, naming the file's row. A new event's file is the organizers' data as given (the fixture's conflicted
// reviews come in flagged), so these rules hold only for an event that was here before the import.

const NOW = "2026-09-29T00:00:00.000Z";
const EVENT = "evt_01";
let h: Handle;

function actor(userId = "usr_organizer"): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email, is_admin AS a FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string; a: number };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.a === 1, roles, sessionKind: "login" };
}

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, EVENT, NOW); // usr_organizer: an administrator and evt_01's organizer
  setHandleForTests(h);
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

type File = {
  event: { id: string };
  tracks: { id: string; name: string }[];
  judges: { id: string; name: string; email: string; tracks: string[] }[];
  teams: { id: string; name: string; members: string[] }[];
  projects: { id: string; team: string; track: string; title: string; submitted_at: string }[];
  scores: { judge: string; project: string; criteria: Record<string, number | null> }[];
};

const exported = (): File => JSON.parse(exportFile(actor(), EVENT, "fixtures.json").body) as File;
const n = (sql: string, ...p: string[]) => (h.sqlite.prepare(sql).get(...p) as { n: number }).n;
const importRows = () => n("SELECT count(*) AS n FROM audit_log WHERE action = 'fixtures.import'");
const team = (file: File, id: string) => file.teams.find((t) => t.id === id)!;
const FULL = { criteria: { functionality: 3, quality: 3, innovation: 3 } };

/** A voter listed by address (no account yet) who voted for one project. */
function listedVoteFor(email: string, projectId: string) {
  h.sqlite
    .prepare("INSERT INTO voters (id, event_id, kind, user_id, email, token_hash, order_seed, created_at) VALUES ('vtr_outside', ?, 'listed', NULL, ?, 'hash-outside', 1, ?)")
    .run(EVENT, email, NOW);
  h.sqlite.prepare("INSERT INTO votes (voter_id, project_id, created_at) VALUES ('vtr_outside', ?, ?)").run(projectId, NOW);
}

function refused(file: File, code: string, names: string[]) {
  const rowsBefore = importRows();
  let caught: unknown;
  try {
    importEventFile(actor(), file);
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the import to be refused").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(409);
  expect(error.code).toBe(code);
  for (const name of names) expect(error.message).toContain(name);
  expect(importRows()).toBe(rowsBefore); // refused whole: no import row, nothing written
}

describe("an import into an event that is here keeps the forms' team rules", () => {
  it("positive control: a new team with one new project, and a new member for a team with room, come in", () => {
    const file = exported();
    const small = file.teams.find((t) => t.members.length === 1)!;
    small.members.push("newcomer@example.org");
    file.teams.push({ id: "tm_new", name: "New Team", members: ["new.captain@example.org"] });
    file.projects.push({ id: "prj_new", team: "tm_new", track: file.tracks[0]!.id, title: "New", submitted_at: "2026-02-28T10:00:00Z" });
    const report = importEventFile(actor(), file);
    expect(report.inserted.projects).toBe(1);
    expect(report.inserted.teamMembers).toBe(2);
  });

  it("known-bad: a member with a community vote for the team is refused, 409 vote_would_change, naming the team and the address", () => {
    const file = exported();
    const roomy = file.teams.find((t) => t.members.length < 4 && file.projects.some((p) => p.team === t.id))!;
    const project = file.projects.find((p) => p.team === roomy.id)!;
    listedVoteFor("outside.voter@example.org", project.id);
    roomy.members.push("outside.voter@example.org");
    refused(file, "vote_would_change", [roomy.id, "outside.voter@example.org"]);
    expect(n("SELECT count(*) AS n FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE u.email = ?", "outside.voter@example.org")).toBe(0);
  });

  it("positive control: the same member with a vote for another team comes in", () => {
    const file = exported();
    const roomy = file.teams.find((t) => t.members.length < 4 && file.projects.some((p) => p.team === t.id))!;
    const other = file.projects.find((p) => p.team !== roomy.id)!;
    listedVoteFor("outside.voter@example.org", other.id);
    roomy.members.push("outside.voter@example.org");
    const report = importEventFile(actor(), file);
    expect(report.inserted.teamMembers).toBe(1);
  });

  it("known-bad: a member that takes a team past the event's size is refused, 409 team_full, naming the team", () => {
    const file = exported();
    const full = file.teams.find((t) => t.members.length === 4)!;
    full.members.push("fifth@example.org");
    refused(file, "team_full", [full.id]);
    expect(n("SELECT count(*) AS n FROM team_members WHERE team_id = ?", full.id)).toBe(4);
  });

  it("known-bad: a new team past the event's size is refused too", () => {
    const file = exported();
    file.teams.push({ id: "tm_big", name: "Big Team", members: ["a@example.org", "b@example.org", "c@example.org", "d@example.org", "e@example.org"] });
    refused(file, "team_full", ["tm_big"]);
  });

  it("known-bad: a second project for a team that has one is refused, 409 team_has_project, naming the project", () => {
    const file = exported();
    file.projects.push({ id: "prj_second", team: "tm_01", track: file.tracks[0]!.id, title: "Second", submitted_at: "2026-02-28T10:00:00Z" });
    refused(file, "team_has_project", ["prj_second", "tm_01"]);
    expect(n("SELECT count(*) AS n FROM projects WHERE id = 'prj_second'")).toBe(0);
  });

  it("known-bad: a new team with two new projects is refused", () => {
    const file = exported();
    file.teams.push({ id: "tm_two", name: "Two Projects", members: ["two.captain@example.org"] });
    for (const id of ["prj_two_a", "prj_two_b"]) file.projects.push({ id, team: "tm_two", track: file.tracks[0]!.id, title: id, submitted_at: "2026-02-28T10:00:00Z" });
    refused(file, "team_has_project", ["prj_two_b"]);
  });

  it("known-bad: a review by a judge who is on the project's team is refused, 409 conflict_of_interest, even when the file leaves them off the team", () => {
    const file = exported();
    const member = team(file, "tm_01").members[1]!; // on tm_01 here; prj_01 is tm_01's project
    team(file, "tm_01").members = team(file, "tm_01").members.filter((m) => m !== member); // the file does not say so
    file.judges.push({ id: "jdg_member", name: "Member Judge", email: member, tracks: [file.projects.find((p) => p.id === "prj_01")!.track] });
    file.scores.push({ judge: "jdg_member", project: "prj_01", ...FULL });
    refused(file, "conflict_of_interest", ["jdg_member", "prj_01"]);
    expect(n("SELECT count(*) AS n FROM assignments WHERE judge_user_id = (SELECT id FROM users WHERE email = ?)", member)).toBe(0);
  });

  it("known-bad: a member added to a team whose project they are assigned to judge is refused, 409 conflict_of_interest", () => {
    const file = exported();
    // jdg_08 (marek.nowak@example.org) reviews prj_01 here; tm_01 has three members, so size is not the reason
    team(file, "tm_01").members.push("marek.nowak@example.org");
    refused(file, "conflict_of_interest", ["tm_01", "marek.nowak@example.org"]);
    expect(n("SELECT count(*) AS n FROM team_members WHERE team_id = 'tm_01'")).toBe(3);
  });

  it("positive control: a new event's file is taken as given: a team's two projects and a judge's review of their own team's project (flagged)", () => {
    const file = {
      event: { id: "evt_given", name: "As Given", submissions_close: "2026-03-01T18:00:00Z" },
      tracks: [{ id: "trk_g", name: "Given" }],
      judges: [{ id: "jdg_g", name: "Judge G", email: "g.judge@example.org", tracks: ["trk_g"] }],
      teams: [{ id: "tm_g", name: "Team G", members: ["g.captain@example.org", "g.judge@example.org"] }],
      projects: ["prj_g1", "prj_g2"].map((id) => ({ id, team: "tm_g", track: "trk_g", title: id, submitted_at: "2026-02-28T10:00:00Z" })),
      scores: [{ judge: "jdg_g", project: "prj_g1", ...FULL }],
    };
    const report = importEventFile(actor(), file);
    expect(report.inserted.projects).toBe(2);
    expect(report.conflicts).toEqual(["scr_jdg_g_prj_g1"]);
  });
});
