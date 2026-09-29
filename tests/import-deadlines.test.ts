import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile, type Fixture } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");

// An import into an event that is already here keeps that event's deadlines, as its forms do (src/server/dal/imports.ts,
// refuseLateAdditions): no new project once submissions have closed, no new review once judging has closed, 409 naming
// the deadline, nothing imported. The fixture event's submissions closed on 1 March 2026; its judging has no close time
// until a test gives it one. Each refusal has its positive control: the same file while the deadline is still ahead.
// A new event's file is its history and comes in whole, whatever its dates.

const NOW = "2026-09-29T00:00:00.000Z";
const EVENT = "evt_01";
const FUTURE = "2999-01-01T00:00:00.000Z";
let h: Handle;
let base: Fixture;

function actor(userId = "usr_organizer"): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email, is_admin AS a FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string; a: number };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.a === 1, roles, sessionKind: "login" };
}

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const loaded = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  base = loaded.fixture;
  importFixtures(h.db, base, { source: "fixtures.json", sha256: loaded.sha256, now: NOW });
  ensureDemoOrganizer(h.db, EVENT, NOW); // usr_organizer: an administrator and evt_01's organizer
  setHandleForTests(h);
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
const snapshot = () => ({
  projects: count("SELECT count(*) AS n FROM projects"),
  teams: count("SELECT count(*) AS n FROM teams"),
  assignments: count("SELECT count(*) AS n FROM assignments"),
  scores: count("SELECT count(*) AS n FROM scores"),
  items: count("SELECT count(*) AS n FROM score_items"),
  imports: count("SELECT count(*) AS n FROM audit_log WHERE action = 'fixtures.import'"),
});
const setEvent = (column: "submissions_close_at" | "judging_close_at", at: string) => h.sqlite.prepare(`UPDATE events SET ${column} = ? WHERE id = ?`).run(at, EVENT);

function expectConflict(call: () => unknown, code: string, message: RegExp) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the import to be refused").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(409);
  expect((caught as HttpError).code).toBe(code);
  expect((caught as HttpError).message).toMatch(message);
}

/** The fixture with one new team and its project. */
function withLateProject(): Fixture {
  const file = structuredClone(base);
  file.teams.push({ id: "tm_late", name: "Late Team", members: ["late@example.org"] });
  file.projects.push({ id: "prj_late", team: "tm_late", track: "trk_01", title: "Late Project", summary: "Came in after the close.", repo_url: "https://example.org/repo/late", submitted_at: "2026-09-28T00:00:00Z" } as Fixture["projects"][number]);
  return file;
}

/** The fixture with one review more: jdg_01 on a project in its own track that it has no review of. */
function withLateReview(): Fixture {
  const file = structuredClone(base);
  const judge = base.judges.find((j) => j.id === "jdg_01")!;
  const project = base.projects.find((p) => judge.tracks.includes(p.track) && !base.scores.some((s) => s.judge === "jdg_01" && s.project === p.id))!;
  file.scores.push({ judge: "jdg_01", project: project.id, criteria: { functionality: 3, quality: 3, innovation: 3 }, comment: "Scored late." } as Fixture["scores"][number]);
  return file;
}

describe("an import into an event that is here keeps its deadlines", () => {
  it("known-bad: a new project after submissions closed is 409 submissions_closed, naming the deadline, and nothing comes in", () => {
    const before = snapshot();
    expectConflict(() => importEventFile(actor(), withLateProject()), "submissions_closed", /Submissions to this event closed at 1 Mar 2026, 18:00 UTC.*Nothing was imported\./);
    expect(snapshot()).toEqual(before); // not even the team the file brings with it
  });

  it("positive control: the same file while submissions are still open adds the project", () => {
    setEvent("submissions_close_at", FUTURE);
    const report = importEventFile(actor(), withLateProject());
    expect(report.inserted.projects).toBe(1);
    expect(count("SELECT count(*) AS n FROM projects WHERE id = 'prj_late'")).toBe(1);
  });

  it("known-bad: a new review after judging closed is 409 judging_closed, naming the deadline, and nothing comes in", () => {
    setEvent("judging_close_at", "2026-06-01T12:00:00.000Z");
    const before = snapshot();
    expectConflict(() => importEventFile(actor(), withLateReview()), "judging_closed", /Judging in this event closed at 1 Jun 2026, 12:00 UTC.*one review.*Nothing was imported\./);
    expect(snapshot()).toEqual(before);
  });

  it("positive control: before judging closes, or with no close time set, the same review comes in", () => {
    setEvent("judging_close_at", FUTURE);
    expect(importEventFile(actor(), withLateReview()).added.reviews).toHaveLength(1);
  });

  it("positive control: a file that adds nothing is no refusal, after both deadlines", () => {
    setEvent("judging_close_at", "2026-06-01T12:00:00.000Z");
    const report = importEventFile(actor(), structuredClone(base));
    expect(Object.values(report.inserted).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("a new event's file is its history: its projects and reviews come in whole, though its dates are long past", () => {
    const file = withLateReview();
    file.event = { ...file.event, id: "evt_history", name: "An Earlier Hack", submissions_close: "2025-03-01T18:00:00Z" };
    const report = importEventFile(actor(), file);
    expect(report.inserted.events).toBe(1);
    expect(report.inserted.projects).toBe(base.projects.length);
    expect(report.added.reviews).toHaveLength(base.scores.length + 1);
  });
});
