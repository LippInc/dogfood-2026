import fs from "node:fs";
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
const { saveRubric } = await import("@/server/dal/organize");
const { latestAudit } = await import("@/server/dal/audit-log");

// fixtures.json now carries an event's rubric, so an import into an event that is already here must not use it
// (or its reviews' criteria) to change what judges have scored: a file whose criteria differ from a scored
// event's is refused whole, 409 rubric_in_use in saveRubric's words; an unscored event takes new criteria only as
// saveRubric would. A new criterion would otherwise stop every finished review counting, with no reason given.

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
const criteriaOf = (event: string) =>
  h.sqlite.prepare("SELECT id, key, label, weight FROM rubric_criteria WHERE event_id = ? ORDER BY position").all(event) as { id: string; key: string; label: string; weight: number }[];
/** reviews with a score for every criterion of the event: what finishedReviews counts */
const complete = (event: string) =>
  n(
    `SELECT count(*) AS n FROM scores s JOIN assignments a ON a.id = s.assignment_id
     WHERE a.event_id = ? AND (SELECT count(*) FROM score_items i WHERE i.score_id = s.id) = (SELECT count(*) FROM rubric_criteria c WHERE c.event_id = ?)`,
    event,
    event,
  );

function refused(call: () => unknown, status: number, code: string): HttpError {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the import to be refused").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(status);
  expect((caught as HttpError).code).toBe(code);
  return caught as HttpError;
}

/** A second judge (a new account) with one finished review of the first project, using these criteria. */
function withLateReview(file: File, criteria: Record<string, number>): File {
  const project = file.projects[0]!;
  file.judges.push({ id: "jdg_late", name: "Late Judge", email: "late.judge@example.org", tracks: [project.track] });
  file.scores.push({ judge: "jdg_late", project: project.id, criteria });
  return file;
}

describe("an import never changes the rubric of an event judges have scored", () => {
  it("positive control: the fixture event's own export imports back onto it and changes nothing", () => {
    const report = importEventFile(actor(), exported());
    expect(Object.values(report.inserted).every((v) => v === 0)).toBe(true);
  });

  it("the fixture event's unchanged export is still the organizers' fixture format: the same sections, and the same values as fixtures.json", () => {
    const original = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8"));
    const file = exported() as unknown as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(Object.keys(original).sort());
    expect(file.rubric).toBeUndefined();
    expect(file.questions).toBeUndefined();
    for (const p of file.projects as Row[]) {
      for (const key of ["description", "video_url", "live_url", "answers"]) expect(p[key], `project ${String(p.id)} ${key}`).toBeUndefined();
    }
  });

  it("known-bad: a file whose rubric brings a new criterion is refused whole, 409 rubric_in_use in saveRubric's words", () => {
    const before = { criteria: criteriaOf(EVENT), complete: complete(EVENT) };
    const file = withLateReview(exported(), { functionality: 5, quality: 5, innovation: 5 });
    file.rubric = [...criteriaOf(EVENT).map((c) => ({ key: c.key, label: c.label, weight: c.weight })), { key: "extra", label: "Extra", weight: 1 }];
    const error = refused(() => importEventFile(actor(), file), 409, "rubric_in_use");
    expect(error.message).toBe("Judges have scored already: the set of criteria is fixed. Labels, prompts and, with a reason, weights can change.");
    // nothing of the file came in: no criterion, no judge, and every finished review still counts
    expect(criteriaOf(EVENT)).toEqual(before.criteria);
    expect(complete(EVENT)).toBe(before.complete);
    expect(n("SELECT count(*) AS n FROM users WHERE email = 'late.judge@example.org'")).toBe(0);
  });

  it("known-bad: a new criterion key arriving through a review's scores (no rubric in the file) is refused the same way", () => {
    const before = criteriaOf(EVENT);
    const file = withLateReview(exported(), { functionality: 5, quality: 5, innovation: 5, extra: 4 });
    refused(() => importEventFile(actor(), file), 409, "rubric_in_use");
    expect(criteriaOf(EVENT)).toEqual(before);
  });

  it("known-bad: a file whose rubric leaves out one of the event's criteria is refused too", () => {
    const file = exported();
    file.rubric = criteriaOf(EVENT).slice(1).map((c) => ({ key: c.key, label: c.label, weight: c.weight }));
    refused(() => importEventFile(actor(), file), 409, "rubric_in_use");
  });

  it("positive control: the same criteria with other labels or weights import, keep the event's own, and the report says so", () => {
    const before = criteriaOf(EVENT);
    const file = withLateReview(exported(), { functionality: 5, quality: 4, innovation: 3 });
    file.rubric = before.map((c) => ({ key: c.key, label: `${c.label} (theirs)`, weight: c.weight + 1 }));
    const report = importEventFile(actor(), file);
    expect(report.inserted.scores).toBe(1);
    expect(criteriaOf(EVENT)).toEqual(before);
    expect(report.skipped.filter((s) => s.kind === "criterion").map((s) => s.id).sort()).toEqual(before.map((c) => c.key).sort());
  });
});

describe("an unscored event takes a file's rubric only as saveRubric would", () => {
  const OPEN = "evt_open";
  function openEvent(): File {
    const file: File = {
      event: { id: OPEN, name: "Open Event", submissions_close: "2026-12-01T18:00:00Z" },
      tracks: [{ id: "trk_open", name: "Open" }],
      rubric: [
        { key: "functionality", label: "Functionality" },
        { key: "quality", label: "Quality" },
      ],
      judges: [],
      teams: [],
      projects: [],
      scores: [],
    };
    importEventFile(actor(), file);
    return file;
  }

  it("a new criterion comes in, and the import's audit row names it", () => {
    const file = openEvent();
    file.rubric = [...file.rubric!, { key: "impact", label: "Impact", weight: 2 }];
    const report = importEventFile(actor(), file);
    expect(criteriaOf(OPEN).map((c) => [c.key, c.weight])).toEqual([["functionality", 1], ["quality", 1], ["impact", 2]]);
    expect(report.added.criteria).toEqual(["impact"]);
    const row = h.sqlite.prepare("SELECT after FROM audit_log WHERE action = 'fixtures.import' AND event_id = ? ORDER BY id DESC LIMIT 1").get(OPEN) as { after: string };
    expect(JSON.parse(row.after).criteria).toEqual(["impact"]);
    expect(latestAudit(h.db, OPEN, 1, ["fixtures.import"])[0]!.parts.map((p) => p.text).join("")).toContain("1 criterion added to the rubric");
  });

  it("known-bad: a new criterion whose label another criterion has is refused (422), as saveRubric refuses two with one name", () => {
    const file = openEvent();
    file.rubric = [...file.rubric!, { key: "quality_2", label: "quality" }];
    refused(() => importEventFile(actor(), file), 422, "invalid");
    expect(criteriaOf(OPEN)).toHaveLength(2);
  });

  it("known-bad: more criteria than the rubric allows (16) are refused (422)", () => {
    const file = openEvent();
    file.rubric = [...file.rubric!, ...Array.from({ length: 15 }, (_, i) => ({ key: `c${i}`, label: `Criterion ${i}` }))];
    refused(() => importEventFile(actor(), file), 422, "invalid");
    expect(criteriaOf(OPEN)).toHaveLength(2);
  });

  it("a review for an event whose criterion the organizer added here scores against that criterion, and is finished only with a score for every one", () => {
    const file = openEvent();
    // the organizer adds a criterion on the Rubric tab: its id is not the one the importer would derive from its key
    saveRubric(actor(), OPEN, [...criteriaOf(OPEN).map((c) => ({ id: c.id, label: c.label, weight: c.weight })), { label: "Impact", weight: 1 }]);
    const impact = criteriaOf(OPEN).find((c) => c.key === "impact")!;
    expect(impact.id).not.toBe(`crit_${OPEN}_impact`);
    file.rubric = criteriaOf(OPEN).map((c) => ({ key: c.key, label: c.label, weight: c.weight }));
    file.judges = [{ id: "jdg_o1", name: "Judge One", email: "judge.one@example.org", tracks: ["trk_open"] }];
    file.teams = [{ id: "tm_o1", name: "Team One", members: ["one@example.org"] }, { id: "tm_o2", name: "Team Two", members: ["two@example.org"] }];
    file.projects = [
      { id: "prj_o1", team: "tm_o1", track: "trk_open", title: "One", submitted_at: "2026-11-30T10:00:00Z" },
      { id: "prj_o2", team: "tm_o2", track: "trk_open", title: "Two", submitted_at: "2026-11-30T10:00:00Z" },
    ];
    file.scores = [
      { judge: "jdg_o1", project: "prj_o1", criteria: { functionality: 4, quality: 4, impact: 5 } },
      { judge: "jdg_o1", project: "prj_o2", criteria: { functionality: 4, quality: 4 } },
    ];
    importEventFile(actor(), file);
    const item = h.sqlite.prepare("SELECT criterion_id AS c FROM score_items WHERE score_id = 'scr_jdg_o1_prj_o1' AND value = 5").get() as { c: string };
    expect(item.c).toBe(impact.id);
    const status = (p: string) => (h.sqlite.prepare("SELECT status FROM assignments WHERE project_id = ?").get(p) as { status: string }).status;
    expect(status("prj_o1")).toBe("done");
    expect(status("prj_o2")).toBe("pending"); // no score for Impact: not a finished review
  });
});
