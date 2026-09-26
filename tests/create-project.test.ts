import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, useHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { actorForToken } from "@/server/session";
import { HttpError } from "@/server/errors";
import { createProject } from "@/server/dal/projects";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;
let participant: Actor;
let judge: Actor;
let oldSeed: string | undefined;
let oldSecret: string | undefined;

beforeEach(() => {
  oldSeed = process.env.SEED_CHECKER_SESSIONS;
  oldSecret = process.env.DOGFOOD_SEED_SECRET;
  process.env.SEED_CHECKER_SESSIONS = "true";
  process.env.DOGFOOD_SEED_SECRET = "test-secret";

  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions did not seed");
  const token = (label: string) => seeded.identities.find((i) => i.label === label)!.token;
  const p = actorForToken(h.db, token("participant"));
  const j = actorForToken(h.db, token("judge_a"));
  if (!p || !j) throw new Error("checker actors did not resolve");
  participant = p;
  judge = j;
  useHandleForTests(h); // createProject goes through getDb()
});

afterEach(() => {
  useHandleForTests(null);
  h.sqlite.close();
  if (oldSeed === undefined) delete process.env.SEED_CHECKER_SESSIONS;
  else process.env.SEED_CHECKER_SESSIONS = oldSeed;
  if (oldSecret === undefined) delete process.env.DOGFOOD_SEED_SECRET;
  else process.env.DOGFOOD_SEED_SECRET = oldSecret;
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

describe("createProject through the real data access layer", () => {
  describe("the fixture event is closed (its close date, 2026-03-01, is in the past)", () => {
    it("refuses a team member by id with 403 submissions_closed", () => {
      expectHttpError(() => createProject(participant, "evt_01", { title: "x", trackId: "trk_01" }), 403, "submissions_closed");
    });

    it("refuses the same request by slug", () => {
      expectHttpError(
        () => createProject(participant, "sample-hack-2026", { title: "x", trackId: "trk_01" }),
        403,
        "submissions_closed",
      );
    });

    it("refuses before the body is even looked at: a null body is 403, never 422", () => {
      expectHttpError(() => createProject(participant, "evt_01", null), 403, "submissions_closed");
    });
  });

  it("a 403 refusal writes exactly one authz.refused audit row and creates no project", () => {
    expect(count("SELECT count(*) AS n FROM projects")).toBe(41);
    const before = auditRows().length;

    expectHttpError(() => createProject(participant, "evt_01", { title: "x", trackId: "trk_01" }), 403, "submissions_closed");

    expect(count("SELECT count(*) AS n FROM projects")).toBe(41);
    const rows = auditRows();
    const refusals = rows.filter((r) => r.action === "authz.refused");
    expect(refusals).toHaveLength(1);
    expect(rows).toHaveLength(before + 1); // the refusal is the only new row
    const refusal = refusals[0]!;
    expect(JSON.stringify(refusal.after)).toContain('"code":"submissions_closed"');
    expect(refusal.eventId).toBe("evt_01");
  });

  it("a missing session is 401 and writes no audit row", () => {
    const before = auditRows().length;
    expectHttpError(() => createProject(null, "evt_01", {}), 401, "unauthenticated");
    expect(auditRows().length).toBe(before);
  });

  it("a judge who is on no team gets 403 not_on_a_team", () => {
    expect(judge.userId).toBe("jdg_24");
    expectHttpError(() => createProject(judge, "evt_01", { title: "x", trackId: "trk_01" }), 403, "not_on_a_team");
  });

  it("an unknown event is 404", () => {
    expectHttpError(() => createProject(participant, "evt_nope", { title: "x", trackId: "trk_01" }), 404, "not_found");
  });

  describe("with the event open", () => {
    beforeEach(() => {
      h.sqlite.exec("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'");
    });

    it("refuses a team that already has a project with 409 team_has_project", () => {
      expectHttpError(() => createProject(participant, "evt_01", { title: "Again", trackId: "trk_01" }), 409, "team_has_project");
    });

    const newMember: Actor = {
      userId: "usr_newmember",
      name: "New Member",
      email: "newmember@example.org",
      isAdmin: false,
      roles: [{ eventId: "evt_01", role: "participant" }],
      sessionKind: "checker",
    };

    function insertTeamWithoutProject() {
      h.sqlite.exec(`
        INSERT INTO users (id, email, name, password_hash, is_admin, created_at)
        VALUES ('usr_newmember', 'newmember@example.org', 'New Member', NULL, 0, '${NOW}');
        INSERT INTO user_roles (user_id, event_id, role, created_at)
        VALUES ('usr_newmember', 'evt_01', 'participant', '${NOW}');
        INSERT INTO teams (id, event_id, name, invite_code, created_at)
        VALUES ('tm_test', 'evt_01', 'Test Team', 'invitest123', '${NOW}');
        INSERT INTO team_members (event_id, team_id, user_id, role, joined_at)
        VALUES ('evt_01', 'tm_test', 'usr_newmember', 'member', '${NOW}');
      `);
    }

    it("creates the project for a team without one: trimmed, submitted, audited, chain intact", () => {
      insertTeamWithoutProject();

      const row = createProject(newMember, "evt_01", { title: "  New thing ", trackId: "trk_01" });

      expect(row.id.startsWith("prj_")).toBe(true);
      expect(row.title).toBe("New thing");
      expect(row.status).toBe("submitted");

      const rows = auditRows();
      const last = rows[rows.length - 1]!;
      expect(last.action).toBe("project.submit");
      expect(last.targetId).toBe(row.id);
      expect(last.eventId).toBe("evt_01");
      expect(verifyAuditChain(h.db).ok).toBe(true);
    });

    it("known-bad: an empty title is 422", () => {
      insertTeamWithoutProject();
      expectHttpError(() => createProject(newMember, "evt_01", { title: "", trackId: "trk_01" }), 422, "invalid");
    });

    it("known-bad: a track that is not one of the event's is 422", () => {
      insertTeamWithoutProject();
      expectHttpError(() => createProject(newMember, "evt_01", { title: "Fine title", trackId: "trk_99" }), 422, "invalid");
    });
  });
});
