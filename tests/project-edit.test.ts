import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, useHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { createProject, getPublicProject, updateProject } from "@/server/dal/projects";
import { getGallery } from "@/server/dal/events";
import { createTeam } from "@/server/dal/teams";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

// prj_01 as the fixtures store it: team tm_01, track trk_04, submitted.
const AS_STORED = {
  title: "Glass Signal",
  summary: "One line of what it does.",
  trackId: "trk_04",
  repoUrl: "https://example.org/repo/01",
  status: "submitted",
};

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  useHandleForTests(h); // the project DAL goes through getDb()
});

afterEach(() => {
  useHandleForTests(null);
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

const userIdByEmail = (email: string) =>
  (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;

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

const titleOf = (id: string) =>
  (h.sqlite.prepare("SELECT title AS t FROM projects WHERE id = ?").get(id) as { t: string }).t;
const statusOf = (id: string) =>
  (h.sqlite.prepare("SELECT status AS s FROM projects WHERE id = ?").get(id) as { s: string }).s;
const answerOf = (projectId: string, questionId: string) =>
  (h.sqlite.prepare("SELECT value FROM custom_answers WHERE project_id = ? AND question_id = ?").get(projectId, questionId) as
    | { value: string }
    | undefined)?.value;
const answerCount = (projectId: string) =>
  (h.sqlite.prepare("SELECT count(*) AS n FROM custom_answers WHERE project_id = ?").get(projectId) as { n: number }).n;

// a member of tm_01 (the team behind prj_01), a member of tm_02, and a judge
const member = () => actorById(userIdByEmail("member1_1@example.org"));
const nonMember = () => actorById(userIdByEmail("lena2@example.org"));
const judge = () => actorById("jdg_24");

describe("updateProject while the fixture event is closed", () => {
  it("refuses a team member with 403 submissions_closed and leaves the title unchanged", () => {
    expectHttpError(
      () => updateProject(member(), "prj_01", { title: "Glass Signal 2", summary: "s", trackId: "trk_04", status: "submitted" }),
      403,
      "submissions_closed",
    );
    expect(titleOf("prj_01")).toBe("Glass Signal");
  });
});

describe("updateProject with the event open", () => {
  beforeEach(() => {
    openEvent();
  });

  it("refuses a non-member with 403 not_your_project", () => {
    expectHttpError(() => updateProject(nonMember(), "prj_01", AS_STORED), 403, "not_your_project");
  });

  it("refuses a judge with 403 not_your_project", () => {
    expectHttpError(() => updateProject(judge(), "prj_01", AS_STORED), 403, "not_your_project");
  });

  it("refuses a missing session with 401 and writes no audit row", () => {
    const before = auditRows().length;
    expectHttpError(() => updateProject(null, "prj_01", AS_STORED), 401, "unauthenticated");
    expect(auditRows().length).toBe(before);
  });

  it("refuses an unknown project id with 404", () => {
    expectHttpError(() => updateProject(member(), "prj_nope", AS_STORED), 404, "not_found");
  });

  it("records exactly the changed fields in one project.update audit row, chain intact", () => {
    const before = auditRows().length;

    const result = updateProject(member(), "prj_01", { ...AS_STORED, title: "Glass Signal 2" });

    expect(result.status).toBe("submitted");
    expect(titleOf("prj_01")).toBe("Glass Signal 2");

    const rows = auditRows();
    expect(rows).toHaveLength(before + 1); // exactly one new row
    const row = rows[rows.length - 1]!;
    expect(row.action).toBe("project.update");
    expect(row.targetId).toBe("prj_01");
    expect(row.before).toEqual({ title: "Glass Signal" }); // only changed fields
    expect(row.after).toEqual({ title: "Glass Signal 2" });
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("keeps a submitted project submitted when the body asks for draft", () => {
    const result = updateProject(member(), "prj_01", { ...AS_STORED, status: "draft" });
    expect(result.status).toBe("submitted");
    expect(statusOf("prj_01")).toBe("submitted");
  });

  describe("a draft on a brand-new team", () => {
    it("stays private until it is submitted with a summary", () => {
      const u = addUser("usr_drafter", "drafter@example.org", "Drafter");
      createTeam(u, "evt_01", { name: "Draft Crew" });

      const draft = createProject(u, "evt_01", { title: "Draft thing", trackId: "trk_01", status: "draft" });
      expect(draft.status).toBe("draft");
      expect(draft.submittedAt).toBeNull();
      expectHttpError(() => getPublicProject("evt_01", draft.id), 404, "not_found");
      expect(getGallery("evt_01").projects.some((p) => p.id === draft.id)).toBe(false);

      // submitting without a summary is a 422 that names summary
      const noSummary = expectHttpError(
        () => updateProject(u, draft.id, { title: "Draft thing", trackId: "trk_01", status: "submitted" }),
        422,
        "invalid",
      );
      expect(Object.keys(noSummary.details as Record<string, unknown>)).toContain("summary");
      expect(statusOf(draft.id)).toBe("draft"); // the failed submit changed nothing

      const submitted = updateProject(u, draft.id, {
        title: "Draft thing",
        summary: "one line",
        trackId: "trk_01",
        status: "submitted",
      });
      expect(submitted.status).toBe("submitted");
      expect(submitted.submittedAt).toBeTruthy();
      const rows = auditRows();
      expect(rows[rows.length - 1]!.action).toBe("project.submit");
      expect(getPublicProject("evt_01", draft.id).project.title).toBe("Draft thing");
    });
  });

  describe("a required custom question", () => {
    beforeEach(() => {
      h.sqlite
        .prepare(
          "INSERT INTO custom_questions (id, event_id, label, help, type, required, position) VALUES ('q_1', 'evt_01', 'What existed before?', '', 'longtext', 1, 0)",
        )
        .run();
    });

    function draftWithQuestion() {
      const u = addUser("usr_author", "author@example.org", "Author");
      createTeam(u, "evt_01", { name: "Answer Crew" });
      const draft = createProject(u, "evt_01", { title: "Q Draft", trackId: "trk_01", status: "draft" });
      return { u, draft };
    }

    it("known-bad: submitting without the required answer is a 422 that names q_1", () => {
      const { u, draft } = draftWithQuestion();

      const err = expectHttpError(
        () => updateProject(u, draft.id, { title: "Q Draft", summary: "one line", trackId: "trk_01", status: "submitted" }),
        422,
        "invalid",
      );
      expect(JSON.stringify(err.details)).toContain("q_1");
      expect(statusOf(draft.id)).toBe("draft");
    });

    it("stores the answer once and updates the same row on the next save", () => {
      const { u, draft } = draftWithQuestion();

      updateProject(u, draft.id, {
        title: "Q Draft",
        summary: "one line",
        trackId: "trk_01",
        status: "submitted",
        answers: { q_1: "Nothing" },
      });
      expect(answerOf(draft.id, "q_1")).toBe("Nothing");

      updateProject(u, draft.id, {
        title: "Q Draft",
        summary: "one line",
        trackId: "trk_01",
        status: "submitted",
        answers: { q_1: "Changed" },
      });
      expect(answerOf(draft.id, "q_1")).toBe("Changed");
      expect(answerCount(draft.id)).toBe(1); // updated, never a second row
    });
  });

  it("known-bad: an answer to an unknown question id is ignored, never an error and never stored", () => {
    const u = addUser("usr_ghost", "ghost@example.org", "Ghost");
    createTeam(u, "evt_01", { name: "Ghost Crew" });

    const draft = createProject(u, "evt_01", {
      title: "Ghost answers",
      trackId: "trk_01",
      status: "draft",
      answers: { q_nope: "should not land" },
    });

    expect(draft.id.startsWith("prj_")).toBe(true); // the call succeeded
    expect(
      (h.sqlite.prepare("SELECT count(*) AS n FROM custom_answers WHERE question_id = 'q_nope'").get() as { n: number }).n,
    ).toBe(0);
    expect(answerCount(draft.id)).toBe(0);
  });
});
