import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { FixtureSchema, importFixtures, loadFixtureFile, type Fixture } from "@/server/db/import-fixtures";
import { assignments, auditLog, events, fixtureImports, projects, scoreItems, scores } from "@/server/db/schema";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;
let db: Db;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  db = h.db;
});

afterEach(() => {
  h.sqlite.close();
});

function loadFixture(): { fixture: Fixture; sha256: string } {
  return loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
}

function importFixture(database: Db, fixture: Fixture, sha256: string) {
  return importFixtures(database, fixture, { source: "fixtures.json", sha256, now: NOW });
}

const tableCount = (table: string): number =>
  (h.sqlite.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;

describe("importFixtures", () => {
  it("imports the fixture with the expected counts and nothing skipped", () => {
    const { fixture, sha256 } = loadFixture();
    const judgeEmails = new Set(fixture.judges.map((j) => j.email));
    const memberEmails = new Set(fixture.teams.flatMap((t) => t.members));
    const membersNotJudges = [...memberEmails].filter((e) => !judgeEmails.has(e));
    const knownTracks = new Set(fixture.tracks.map((t) => t.id));
    const judgeTrackRows = fixture.judges.flatMap((j) => j.tracks).filter((t) => knownTracks.has(t));
    const integerValues = fixture.scores
      .flatMap((s) => Object.values(s.criteria))
      .filter((v): v is number => typeof v === "number");

    const r = importFixture(db, fixture, sha256);

    expect(r.inserted.events).toBe(1);
    expect(r.inserted.tracks).toBe(fixture.tracks.length);
    expect(r.inserted.tracks).toBe(8);
    expect(r.inserted.rubricCriteria).toBe(3);
    expect(r.inserted.users).toBe(fixture.judges.length + membersNotJudges.length);
    expect(r.inserted.userRoles).toBe(fixture.judges.length + memberEmails.size);
    expect(r.inserted.judgeTracks).toBe(judgeTrackRows.length);
    expect(r.inserted.teams).toBe(fixture.teams.length);
    expect(r.inserted.teamMembers).toBe(memberEmails.size);
    expect(r.inserted.projects).toBe(fixture.projects.length);
    expect(r.inserted.projects).toBe(41);
    expect(r.inserted.assignmentRuns).toBe(1);
    expect(r.inserted.assignments).toBe(fixture.scores.length);
    expect(r.inserted.assignments).toBe(126);
    expect(r.inserted.scores).toBe(fixture.scores.length);
    expect(r.inserted.scores).toBe(126);
    expect(r.inserted.scoreItems).toBe(integerValues.length);
    expect(integerValues.length).toBe(378);
    expect(r.inserted.scoreComments).toBe(fixture.scores.filter((s) => s.comment).length);
    expect(r.skipped).toEqual([]);
    expect(Object.values(r.existing).every((v) => v === 0)).toBe(true);
  });

  it("a second import inserts nothing, changes no rows and adds no audit row", () => {
    const { fixture, sha256 } = loadFixture();
    const first = importFixture(db, fixture, sha256);

    const tables = [
      "events",
      "tracks",
      "rubric_criteria",
      "users",
      "user_roles",
      "judge_tracks",
      "teams",
      "team_members",
      "projects",
      "assignment_runs",
      "assignments",
      "scores",
      "score_items",
      "score_comments",
    ];
    const before = Object.fromEntries(tables.map((t) => [t, tableCount(t)]));

    const again = importFixture(db, fixture, sha256);

    expect(Object.values(again.inserted).every((v) => v === 0)).toBe(true);
    expect(again.skipped).toEqual([]);
    expect(again.existing).toEqual(first.inserted);
    for (const [table, n] of Object.entries(before)) {
      expect(tableCount(table)).toBe(n);
    }
    expect(tableCount("audit_log")).toBe(1);
    const auditRows = db.select({ action: auditLog.action }).from(auditLog).all();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("fixtures.import");
    const imports = db.select().from(fixtureImports).all();
    expect(imports).toHaveLength(2);
    expect(imports[0]?.counts).toEqual(first.inserted);
    expect(imports[1]?.counts).toEqual(again.inserted);
  });

  it("stores the event's submissions_close exactly as the fixture gives it", () => {
    const { fixture, sha256 } = loadFixture();
    importFixture(db, fixture, sha256);
    const event = db.select().from(events).where(eq(events.id, fixture.event.id)).get();
    expect(event?.submissionsCloseAt).toBe("2026-03-01T18:00:00Z");
    expect(event?.submissionsCloseAt).toBe(fixture.event.submissions_close);
  });

  it("gives judge jdg_07 exactly three scores and every one of its score items is 4", () => {
    const { fixture, sha256 } = loadFixture();
    importFixture(db, fixture, sha256);

    const rows = db.select().from(assignments).where(eq(assignments.judgeUserId, "jdg_07")).all();
    expect(rows).toHaveLength(3);

    const expected = fixture.scores.filter((s) => s.judge === "jdg_07");
    expect(expected).toHaveLength(3);
    for (const s of expected) {
      const scoreId = `scr_${s.judge}_${s.project}`;
      const score = db.select().from(scores).where(eq(scores.id, scoreId)).get();
      expect(score).toBeDefined();
      expect(score?.submittedAt).toBe(NOW);
      const items = db.select().from(scoreItems).where(eq(scoreItems.scoreId, scoreId)).all();
      expect(items).toHaveLength(3);
      for (const item of items) expect(item.value).toBe(4);
    }
  });

  it("imports both rows of the duplicate Dry Harbour submission unchanged", () => {
    const { fixture, sha256 } = loadFixture();
    importFixture(db, fixture, sha256);
    for (const id of ["prj_07", "prj_41"]) {
      const p = db.select().from(projects).where(eq(projects.id, id)).get();
      expect(p).toBeDefined();
      expect(p?.teamId).toBe("tm_07");
      expect(p?.title).toBe("Dry Harbour");
      expect(p?.status).toBe("submitted");
    }
  });

  it("reports known-bad scores instead of throwing", () => {
    const { fixture, sha256 } = loadFixture();
    const bad: Fixture = structuredClone(fixture);

    // an existing judge-project pair with no score yet: a judge in the project's track
    const scored = new Set(fixture.scores.map((s) => `${s.judge}|${s.project}`));
    const trackOf = new Map(fixture.projects.map((p) => [p.id, p.track]));
    const candidates: { judge: string; project: string }[] = [];
    for (const j of fixture.judges) {
      for (const p of fixture.projects) {
        if (j.tracks.includes(trackOf.get(p.id) ?? "") && !scored.has(`${j.id}|${p.id}`)) {
          candidates.push({ judge: j.id, project: p.id });
        }
      }
    }
    expect(candidates.length).toBeGreaterThan(0);
    const pair = candidates[0]!;

    bad.scores.push(
      { judge: "jdg_01", project: "prj_99", criteria: { functionality: 3, quality: 3, innovation: 3 } },
      { judge: pair.judge, project: pair.project, criteria: { functionality: 9, quality: 3, innovation: 3 } },
    );

    const r = importFixture(db, bad, sha256);

    expect(r.skipped).toHaveLength(2);
    expect(r.skipped.some((e) => e.reason.includes("prj_99"))).toBe(true);
    expect(r.skipped.some((e) => e.reason.includes("out of range"))).toBe(true);
    expect(r.inserted.assignments).toBe(fixture.scores.length);
    expect(r.inserted.scores).toBe(fixture.scores.length);
    expect(r.inserted.scoreItems).toBe(378);
    expect(tableCount("assignments")).toBe(126);
    expect(tableCount("scores")).toBe(126);
  });

  it("a missing criterion leaves the assignment pending and never writes a zero item", () => {
    const { fixture, sha256 } = loadFixture();
    const partial: Fixture = structuredClone(fixture);
    const target = partial.scores.find((s) => s.judge === "jdg_08" && s.project === "prj_01");
    if (!target) throw new Error("fixture must contain jdg_08's score for prj_01");
    delete target.criteria.innovation;

    importFixture(db, partial, sha256);

    const assignment = db.select().from(assignments).where(eq(assignments.id, "asg_jdg_08_prj_01")).get();
    expect(assignment?.status).toBe("pending");

    const score = db.select().from(scores).where(eq(scores.id, "scr_jdg_08_prj_01")).get();
    expect(score).toBeDefined();
    expect(score?.submittedAt).toBeNull();

    const items = db.select().from(scoreItems).where(eq(scoreItems.scoreId, "scr_jdg_08_prj_01")).all();
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.value === 0)).toBe(false);
    expect(items.every((i) => i.value >= 1 && i.value <= 5)).toBe(true);
    expect(items.some((i) => i.criterionId.includes("innovation"))).toBe(false);
  });

  it("known-bad: a second import that completes a partly imported review finishes it as a judge's save would", () => {
    const { fixture, sha256 } = loadFixture();
    const partial: Fixture = structuredClone(fixture);
    delete partial.scores.find((s) => s.judge === "jdg_08" && s.project === "prj_01")!.criteria.innovation;
    importFixture(db, partial, sha256);
    expect(db.select().from(assignments).where(eq(assignments.id, "asg_jdg_08_prj_01")).get()?.status).toBe("pending");

    // positive control: the same partial file again changes nothing
    importFixture(db, partial, sha256);
    expect(db.select().from(assignments).where(eq(assignments.id, "asg_jdg_08_prj_01")).get()?.status).toBe("pending");
    expect(db.select().from(scores).where(eq(scores.id, "scr_jdg_08_prj_01")).get()?.submittedAt).toBeNull();

    const later = "2026-09-27T09:00:00.000Z";
    importFixtures(db, fixture, { source: "fixtures.json", sha256, now: later });

    expect(db.select().from(scoreItems).where(eq(scoreItems.scoreId, "scr_jdg_08_prj_01")).all()).toHaveLength(3);
    expect(db.select().from(assignments).where(eq(assignments.id, "asg_jdg_08_prj_01")).get()?.status).toBe("done");
    expect(db.select().from(scores).where(eq(scores.id, "scr_jdg_08_prj_01")).get()?.submittedAt).toBe(later);
  });

  it("a recused assignment stays recused when a second import brings its missing score", () => {
    const { fixture, sha256 } = loadFixture();
    const partial: Fixture = structuredClone(fixture);
    delete partial.scores.find((s) => s.judge === "jdg_08" && s.project === "prj_01")!.criteria.innovation;
    importFixture(db, partial, sha256);
    h.sqlite.prepare("UPDATE assignments SET status = 'recused' WHERE id = 'asg_jdg_08_prj_01'").run();
    importFixture(db, fixture, sha256);
    expect(db.select().from(assignments).where(eq(assignments.id, "asg_jdg_08_prj_01")).get()?.status).toBe("recused");
  });

  it("rejects a malformed fixture file", () => {
    expect(() => FixtureSchema.parse({ event: {} })).toThrow();
  });
});
