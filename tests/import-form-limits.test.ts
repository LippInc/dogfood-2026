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
const { getOrganizerEvent, saveQuestions, saveRubric } = await import("@/server/dal/organize");

// Imported criteria and questions keep the Rubric and Questions tabs' limits. The import took a criterion label of
// 1 to 80 characters and a prompt up to 2,000, the tab 2 to 60 and 200, so after such an import every later save of
// the rubric was refused ("Check the highlighted fields"); questions: 30 per file on top of those there (the tab
// allows 20), labels from 1 character (the tab: 3), help up to 1,000 (the tab: 300). A file past a limit is now
// refused whole, 422, naming the row; a file at the limits imports, and the tab then saves what it brought.

const NOW = "2026-09-29T00:00:00.000Z";
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
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

type Criterion = { key: string; label: string; prompt?: string; weight?: number };
type Question = { id: string; label: string; help?: string; type?: string; required?: boolean };
const event = (over: { rubric?: Criterion[]; questions?: Question[]; scores?: { judge: string; project: string; criteria: Record<string, number> }[]; id?: string } = {}) => ({
  event: { id: over.id ?? "evt_new", name: `Event ${over.id ?? "new"}`, submissions_close: "2026-03-01T18:00:00Z" },
  tracks: [{ id: "trk_n", name: "Only track" }],
  ...(over.rubric ? { rubric: over.rubric } : {}),
  ...(over.questions ? { questions: over.questions } : {}),
  judges: [{ id: "jdg_n", name: "A judge", email: "judge.n@example.org", tracks: ["trk_n"] }],
  teams: [{ id: "tm_n", name: "A team", members: ["member.n@example.org"] }],
  projects: [{ id: "prj_n", team: "tm_n", track: "trk_n", title: "A project", submitted_at: "2026-03-01T12:00:00Z" }],
  scores: over.scores ?? [],
});
const rubric = (n: number, over: Partial<Criterion> = {}): Criterion[] => Array.from({ length: n }, (_, i) => ({ key: `c${i}`, label: `Criterion ${i}`, ...over }));
const questions = (n: number, over: Partial<Question> = {}): Question[] => Array.from({ length: n }, (_, i) => ({ id: `q_${i}`, label: `Question ${i}`, ...over }));
const events = () => (h.sqlite.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n;

function refused(file: unknown, ...names: (string | RegExp)[]) {
  const before = events();
  let caught: unknown;
  try {
    importEventFile(actor(), file);
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the import to be refused").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(422);
  for (const n of names) expect((caught as HttpError).message).toMatch(n);
  expect(events()).toBe(before); // refused whole
}

describe("imported criteria keep the Rubric tab's limits", () => {
  it("known-bad: a label of 1 character, or of 61", () => {
    refused(event({ rubric: [{ key: "a", label: "A" }] }), "rubric.0.label", /2 to 60 characters/);
    refused(event({ rubric: [...rubric(2), { key: "long", label: "L".repeat(61) }] }), "rubric.2.label", /2 to 60 characters/);
  });

  it("known-bad: a prompt of 201 characters", () => {
    refused(event({ rubric: [{ key: "a", label: "Aa", prompt: "p".repeat(201) }] }), "rubric.0.prompt", /200 characters/);
  });

  it("known-bad: 17 criteria in the file's rubric, or with the scores' keys added", () => {
    refused(event({ rubric: rubric(17) }), "rubric", /16/);
    refused(event({ rubric: rubric(16), scores: [{ judge: "jdg_n", project: "prj_n", criteria: { extra: 3 } }] }), /at most 16 criteria/, /17/);
  });

  it("known-bad: a label a score's key gives that is too short or too long, named by its key", () => {
    refused(event({ scores: [{ judge: "jdg_n", project: "prj_n", criteria: { x: 3 } }] }), /criterion x/, /2 to 60 characters/);
    refused(event({ scores: [{ judge: "jdg_n", project: "prj_n", criteria: { ["k".repeat(61)]: 3 } }] }), /2 to 60 characters/);
  });

  it("known-bad: two criteria of a new event with one label", () => {
    refused(event({ rubric: [{ key: "a", label: "Impact" }, { key: "b", label: "impact" }] }), /"impact"/i);
  });

  it("positive control: a rubric at the limits imports, and the Rubric tab saves it back unchanged", () => {
    importEventFile(actor(), event({ rubric: rubric(16, { label: undefined }).map((c, i) => ({ ...c, label: `${String(i).padStart(2, "0")}${"L".repeat(58)}`, prompt: "p".repeat(200) })) }));
    const o = getOrganizerEvent(actor(), "evt_new");
    expect(o.rubric).toHaveLength(16);
    expect(() => saveRubric(actor(), "evt_new", o.rubric.map((c) => ({ id: c.id, label: c.label, prompt: c.prompt, weight: c.weight })))).not.toThrow();
  });
});

describe("imported questions keep the Questions tab's limits", () => {
  it("known-bad: a label of 2 characters, help of 301, and 21 questions in one file", () => {
    refused(event({ questions: [{ id: "q1", label: "Hi" }] }), "questions.0.label", /3 to 200 characters/);
    refused(event({ questions: [{ id: "q1", label: "Why?", help: "h".repeat(301) }] }), "questions.0.help", /300 characters/);
    refused(event({ questions: questions(21) }), "questions", /20/);
  });

  it("known-bad: an event here with 15 questions and a file bringing 6 more", () => {
    importEventFile(actor(), event({ questions: questions(15) }));
    refused(event({ questions: questions(6).map((q) => ({ ...q, id: `q_more_${q.id}`, label: `More ${q.label}` })) }), /6 new questions/, /21/, /at most 20/);
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM custom_questions WHERE event_id = 'evt_new'").get() as { n: number }).n).toBe(15);
  });

  it("positive control: 20 questions at the limits import, and the Questions tab saves them back", () => {
    importEventFile(actor(), event({ questions: questions(20).map((q, i) => ({ ...q, label: `${String(i).padStart(2, "0")}${"Q".repeat(198)}`, help: "h".repeat(300) })) }));
    const o = getOrganizerEvent(actor(), "evt_new");
    expect(o.questions).toHaveLength(20);
    expect(() => saveQuestions(actor(), "evt_new", o.questions.map(({ id, label, help, type, required }) => ({ id, label, help, type, required })))).not.toThrow();
  });
});

describe("the files the portal itself brings still import", () => {
  it("positive control: the fixture's export round trip changes nothing, and fixtures.json imports on a fresh database", () => {
    const report = importEventFile(actor(), JSON.parse(exportFile(actor(), "evt_01", "fixtures.json").body));
    expect(Object.values(report.inserted).reduce((a, b) => a + b, 0)).toBe(0);
    const fresh = openDatabase(":memory:");
    runMigrations(fresh, path.join(process.cwd(), "drizzle"));
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    expect(importFixtures(fresh.db, fixture, { source: "fixtures.json", sha256, now: NOW }).inserted.rubricCriteria).toBe(3);
    fresh.sqlite.close();
  });
});
