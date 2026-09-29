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

// A review given out on the portal has an assignment and a score with random ids (asg_xxxx, scr_xxxx), not the
// importer's asg_<judge>_<project> and scr_<judge>_<project>. Importing an export of such an event inserted the
// assignment (ignored by the unique index on judge and project) and then a score pointing at asg_<judge>_<project>,
// which does not exist: "FOREIGN KEY constraint failed", a 500. The importer finds the pair's assignment and score by
// judge and project, as it finds a criterion by key.

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
  ensureDemoOrganizer(h.db, EVENT, NOW);
  setHandleForTests(h);
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

const rows = (sql: string) => JSON.stringify(h.sqlite.prepare(sql).all());
/** Everything judging rests on, row by row. */
const judging = () =>
  [
    rows("SELECT * FROM assignments ORDER BY id"),
    rows("SELECT * FROM scores ORDER BY id"),
    rows("SELECT * FROM score_items ORDER BY score_id, criterion_id"),
    rows("SELECT * FROM score_comments ORDER BY score_id"),
  ].join("\n");

/** A project in jdg_01's track (trk_03) that the fixture gives jdg_01 no review of. */
function freeProject(): string {
  const p = h.sqlite
    .prepare("SELECT id FROM projects WHERE track_id = 'trk_03' AND id NOT IN (SELECT project_id FROM assignments WHERE judge_user_id = 'jdg_01') ORDER BY id LIMIT 1")
    .get() as { id: string } | undefined;
  if (!p) throw new Error("no free project for jdg_01 in trk_03");
  return p.id;
}

/**
 * A review given out on the portal: its own assignment id, in a portal run, and its own score id. "pending" has no
 * score yet, "draft" has 2 of the 3 criteria and no feedback (the judge's console saved it half way), "finished" has
 * all three and feedback.
 */
function portalReview(project: string, state: "pending" | "draft" | "finished") {
  h.sqlite.prepare("INSERT INTO assignment_runs (id, event_id, mode, seed, params, created_at) VALUES ('run_portal', ?, 'topup', 7, '{}', ?)").run(EVENT, NOW);
  h.sqlite
    .prepare("INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, batch_no, position, status, created_at) VALUES ('asg_k3j9x2', ?, 'jdg_01', ?, 'run_portal', 1, 0, ?, ?)")
    .run(EVENT, project, state === "finished" ? "done" : "pending", NOW);
  if (state === "pending") return;
  h.sqlite.prepare("INSERT INTO scores (id, assignment_id, submitted_at, updated_at, conflicted) VALUES ('scr_q8w1e5', 'asg_k3j9x2', ?, ?, 0)").run(state === "finished" ? NOW : null, NOW);
  const values = state === "finished" ? ([["functionality", 4], ["quality", 3], ["innovation", 5]] as const) : ([["functionality", 4], ["quality", 3]] as const);
  for (const [key, v] of values) {
    h.sqlite.prepare("INSERT INTO score_items (score_id, criterion_id, value) VALUES ('scr_q8w1e5', ?, ?)").run(`crit_${EVENT}_${key}`, v);
  }
  if (state === "finished") h.sqlite.prepare("INSERT INTO score_comments (score_id, feedback, private_note) VALUES ('scr_q8w1e5', 'Given on the portal.', '')").run();
}

type FileScore = { judge: string; project: string; criteria: Record<string, number>; comment?: string };

describe("an event whose reviews were given out on the portal imports back", () => {
  it("the export of an event with a finished portal review imports back and changes nothing", () => {
    portalReview(freeProject(), "finished");
    const file = JSON.parse(exportFile(actor(), EVENT, "fixtures.json").body) as { scores: { judge: string }[] };
    expect(file.scores.some((s) => s.judge === "jdg_01")).toBe(true); // the portal's review is in the file
    const before = judging();
    const report = importEventFile(actor(), file);
    expect(judging()).toBe(before);
    expect(Object.values(report.inserted).reduce((a, b) => a + b, 0)).toBe(0);
  });

  // An import never writes into a review the portal handed out: a score there would count in the results under the
  // judge's name though the judge never finished it, and their console would show values they never entered.
  it("a file's review for a pending review the portal handed out adds nothing to it and is named in skipped", () => {
    const project = freeProject();
    portalReview(project, "pending");
    const file = JSON.parse(exportFile(actor(), EVENT, "fixtures.json").body) as { scores: FileScore[] };
    file.scores.push({ judge: "jdg_01", project, criteria: { functionality: 2, quality: 2, innovation: 2 }, comment: "From the file." });
    const before = judging();
    const report = importEventFile(actor(), file);
    expect(judging()).toBe(before);
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM scores WHERE assignment_id = 'asg_k3j9x2'").get()).toEqual({ n: 0 });
    expect(report.skipped).toContainEqual(expect.objectContaining({ kind: "score", id: `jdg_01|${project}`, reason: expect.stringMatching(/handed out on the portal/) }));
    expect(report.added.reviews.find((r) => r.project === project)).toBeUndefined();
  });

  it("a file's review for a judge's draft on the portal adds no value and no feedback to it", () => {
    const project = freeProject();
    portalReview(project, "draft");
    const file = JSON.parse(exportFile(actor(), EVENT, "fixtures.json").body) as { scores: FileScore[] };
    const mine = file.scores.find((s) => s.judge === "jdg_01" && s.project === project);
    if (mine) Object.assign(mine, { criteria: { ...mine.criteria, innovation: 1 }, comment: "From the file." });
    else file.scores.push({ judge: "jdg_01", project, criteria: { functionality: 4, quality: 3, innovation: 1 }, comment: "From the file." });
    const before = judging();
    const report = importEventFile(actor(), file);
    expect(judging()).toBe(before);
    expect(h.sqlite.prepare("SELECT submitted_at AS s FROM scores WHERE id = 'scr_q8w1e5'").get()).toEqual({ s: null });
    expect(report.skipped).toContainEqual(expect.objectContaining({ kind: "score", id: `jdg_01|${project}`, reason: expect.stringMatching(/handed out on the portal/) }));
  });

  it("positive control: a changed file still adds to an unfinished review an earlier import brought in", () => {
    const file = (criteria: Record<string, number | null>) => ({
      event: { id: "evt_y", name: "Y", submissions_close: "2026-03-01T18:00:00Z" },
      tracks: [{ id: "trk_y", name: "Y" }],
      judges: [{ id: "jdg_y", name: "Judge", email: "y@example.org", tracks: ["trk_y"] }],
      teams: [{ id: "tm_y", name: "Team", members: ["my@example.org"] }],
      projects: [{ id: "prj_y", team: "tm_y", track: "trk_y", title: "P", submitted_at: "2026-03-01T12:00:00Z" }],
      scores: [{ judge: "jdg_y", project: "prj_y", criteria }],
    });
    importEventFile(actor(), file({ functionality: 4, quality: 3, innovation: null }));
    const report = importEventFile(actor(), file({ functionality: 4, quality: 3, innovation: 2 }));
    expect(h.sqlite.prepare("SELECT value FROM score_items WHERE score_id = 'scr_jdg_y_prj_y' AND criterion_id = 'crit_evt_y_innovation'").get()).toEqual({ value: 2 });
    expect(report.skipped.filter((s) => s.kind === "score")).toEqual([]);
    expect(report.added.reviews).toEqual([expect.objectContaining({ project: "prj_y", values: { innovation: 2 } })]);
  });

  it("a file judge id that an earlier file gave another person: their review is skipped and named, never put on the other's", () => {
    const file = (email: string, v: number) => ({
      event: { id: "evt_z", name: "Z", submissions_close: "2026-03-01T18:00:00Z" },
      tracks: [{ id: "trk_z", name: "Z" }],
      judges: [{ id: "jdg_z", name: "Judge", email, tracks: ["trk_z"] }],
      teams: [{ id: "tm_z", name: "Team", members: ["m@example.org"] }],
      projects: [{ id: "prj_z", team: "tm_z", track: "trk_z", title: "P", submitted_at: "2026-03-01T12:00:00Z" }],
      scores: [{ judge: "jdg_z", project: "prj_z", criteria: { functionality: v, quality: v, innovation: v } }],
    });
    importEventFile(actor(), file("first@example.org", 5));
    const before = judging();
    const report = importEventFile(actor(), file("second@example.org", 1));
    expect(judging()).toBe(before);
    expect(report.skipped.find((s) => s.kind === "score")?.reason).toMatch(/belongs to another judge's review/);
  });

  it("positive control: the export of the fixture alone imports back and changes nothing", () => {
    const before = judging();
    importEventFile(actor(), JSON.parse(exportFile(actor(), EVENT, "fixtures.json").body));
    expect(judging()).toBe(before);
  });
});
