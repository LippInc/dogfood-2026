import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");
const { exportFile } = await import("@/server/dal/exports");

// fixtures.json now carries each project's answers to the event's questions. An import into an event that is
// already here must not use them to write into a team's project: answers come in only with a project the import
// creates, never into one that is here already (another team's, perhaps long after the close).

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

type Row = Record<string, unknown>;
type File = {
  event: Row & { id: string };
  tracks: { id: string; name: string }[];
  rubric?: { key: string; label: string; prompt?: string; weight?: number }[];
  questions?: { id: string; label: string }[];
  judges: { id: string; name: string; email: string; tracks: string[] }[];
  teams: { id: string; name: string; members: string[] }[];
  projects: (Row & { id: string; team: string; track: string; answers?: Record<string, string> })[];
  scores: { judge: string; project: string; criteria: Record<string, number | null>; comment?: string }[];
};

const exported = (event = EVENT): File => JSON.parse(exportFile(actor(), event, "fixtures.json").body) as File;
const n = (sql: string, ...p: string[]) => (h.sqlite.prepare(sql).get(...p) as { n: number }).n;
describe("answers come in only with a project the import creates", () => {
  function withQuestion() {
    h.sqlite.prepare("INSERT INTO custom_questions (id, event_id, label, help, type, required, position) VALUES ('q_stack', ?, 'What did you build it with?', '', 'text', 0, 0)").run(EVENT);
    return (h.sqlite.prepare("SELECT id FROM projects WHERE event_id = ? AND status = 'submitted' ORDER BY id LIMIT 1").get(EVENT) as { id: string }).id;
  }

  it("known-bad: answers for a project that is here already (another team's, after the close) are not written, and the report says so", () => {
    const theirs = withQuestion();
    const file = exported();
    file.projects.find((p) => p.id === theirs)!.answers = { q_stack: "Words the team never wrote" };
    const report = importEventFile(actor(), file);
    expect(n("SELECT count(*) AS n FROM custom_answers WHERE project_id = ?", theirs)).toBe(0);
    expect(report.inserted.customAnswers).toBe(0);
    expect(report.skipped).toContainEqual(expect.objectContaining({ kind: "answer", id: `${theirs}:q_stack` }));
  });

  it("an answer that is already the project's own is counted as there, not skipped (the event's own export imports back quietly)", () => {
    const theirs = withQuestion();
    h.sqlite.prepare("INSERT INTO custom_answers (project_id, question_id, value) VALUES (?, 'q_stack', 'Rust')").run(theirs);
    const report = importEventFile(actor(), exported());
    expect(report.skipped.filter((s) => s.kind === "answer")).toEqual([]);
    expect(report.existing.customAnswers).toBe(1);
    expect(Object.values(report.inserted).every((v) => v === 0)).toBe(true);
  });

  it("positive control: a project the import creates brings its answers", () => {
    withQuestion();
    // a project comes into an event that is here only while its submissions are open (tests/import-deadlines.test.ts);
    // the fixture event's closed on 1 March 2026
    h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(EVENT);
    const file = exported();
    file.teams.push({ id: "tm_new", name: "New Team", members: ["new.captain@example.org"] });
    file.projects.push({ id: "prj_new", team: "tm_new", track: file.tracks[0]!.id, title: "New", submitted_at: "2026-02-28T10:00:00Z", answers: { q_stack: "Go" } });
    const report = importEventFile(actor(), file);
    expect(report.inserted.customAnswers).toBe(1);
    expect(h.sqlite.prepare("SELECT value FROM custom_answers WHERE project_id = 'prj_new'").get()).toEqual({ value: "Go" });
  });
});
