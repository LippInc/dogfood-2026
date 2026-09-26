import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { appendAudit, GENESIS_HASH, verifyAuditChain, type AuditEntry } from "@/server/audit";
import { assertTriggers } from "@/server/db/triggers";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
});

afterEach(() => {
  h.sqlite.close();
});

const entry = (i: number): AuditEntry => ({
  actorUserId: "jdg_24",
  actorLabel: "Judge A",
  action: `test.step_${i}`,
  eventId: "evt_01",
  targetType: "event",
  targetId: "evt_01",
  after: { step: i },
});

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;

describe("the audit chain", () => {
  it("appends three rows in one transaction: the chain verifies with 1 fixture row + 3, head = last hash, genesis prev", () => {
    const hashes = h.db.transaction((tx) =>
      [entry(1), entry(2), entry(3)].map((e, i) => appendAudit(tx, e, `2026-09-26T12:00:0${i + 1}.000Z`)),
    );

    expect(count("SELECT count(*) AS n FROM audit_log")).toBe(4);

    const check = verifyAuditChain(h.db);
    expect(check).toMatchObject({ ok: true, rows: 4, head: hashes[2] });

    const rows = h.sqlite
      .prepare("SELECT id, prev_hash, hash FROM audit_log ORDER BY id")
      .all() as { id: number; prev_hash: string; hash: string }[];
    expect(rows[0]?.prev_hash).toBe(GENESIS_HASH); // the fixture import row starts from genesis
    expect(rows[1]?.prev_hash).toBe(rows[0]?.hash); // each append chains onto the head
  });

  it("UPDATE and DELETE on audit_log are rejected by the append-only triggers", () => {
    expect(() => h.sqlite.prepare("UPDATE audit_log SET action = 'x' WHERE id = 1").run()).toThrow(/append-only/);
    expect(() => h.sqlite.prepare("DELETE FROM audit_log WHERE id = 1").run()).toThrow(/append-only/);
  });

  it("known-bad: an edit made after dropping the update trigger breaks the chain at that row, and boot re-arms the trigger", () => {
    h.db.transaction((tx) => {
      appendAudit(tx, entry(1));
      appendAudit(tx, entry(2));
      appendAudit(tx, entry(3));
    });
    expect(verifyAuditChain(h.db).ok).toBe(true);

    h.sqlite.exec("DROP TRIGGER audit_log_no_update");
    // the edit goes through now — this is the damage the chain must surface
    expect(() => h.sqlite.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = 3").run()).not.toThrow();

    const check = verifyAuditChain(h.db);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.brokenAtId).toBe(3);

    // the boot-time assertion recreates the missing trigger and the guard holds again
    const report = assertTriggers(h.sqlite);
    expect(report.created).toContain("audit_log_no_update");
    expect(() => h.sqlite.prepare("UPDATE audit_log SET action = 'y' WHERE id = 4").run()).toThrow(/append-only/);
  });

  it("known-bad: a no-op replacement of the delete trigger is detected and restored", () => {
    h.sqlite.exec("DROP TRIGGER audit_log_no_delete");
    h.sqlite.exec("CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT 1; END;");
    // the no-op lets a DELETE through…
    expect(() => h.sqlite.prepare("DELETE FROM audit_log WHERE id = 1").run()).not.toThrow();

    const report = assertTriggers(h.sqlite);
    expect(report.restored).toContain("audit_log_no_delete");
    // …and after the restore the append-only guarantee holds again, on a row that exists
    h.db.transaction((tx) => {
      appendAudit(tx, { actorUserId: null, actorLabel: "system", action: "test.after_restore" });
    });
    const remaining = (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n;
    expect(remaining).toBeGreaterThan(0);
    expect(() => h.sqlite.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get() as { n: number }).n).toBe(remaining);
  });

  it("known-bad: score_items outside its criterion's range are rejected by the trigger", () => {
    // a judge-project pair with no score yet: jdg_01 on one of its own tracks
    const track = h.sqlite
      .prepare("SELECT track_id FROM judge_tracks WHERE judge_user_id = ? AND event_id = 'evt_01'")
      .get("jdg_01") as { track_id: string };
    const project = h.sqlite
      .prepare(
        `SELECT p.id FROM projects p
         WHERE p.event_id = 'evt_01' AND p.track_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM assignments a
             WHERE a.judge_user_id = 'jdg_01' AND a.project_id = p.id
           )
         LIMIT 1`,
      )
      .get(track.track_id) as { id: string } | undefined;
    expect(project).toBeDefined();

    h.sqlite
      .prepare(
        `INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, batch_no, position, status, created_at)
         VALUES ('asg_test', 'evt_01', 'jdg_01', ?, 'run_fixture_evt_01', 1, 99, 'pending', ?)`,
      )
      .run(project!.id, NOW);
    h.sqlite
      .prepare(
        `INSERT INTO scores (id, assignment_id, submitted_at, updated_at, conflicted)
         VALUES ('scr_test', 'asg_test', NULL, ?, 0)`,
      )
      .run(NOW);

    const insertItem = (value: number) =>
      h.sqlite
        .prepare("INSERT INTO score_items (score_id, criterion_id, value) VALUES ('scr_test', 'crit_evt_01_functionality', ?)")
        .run(value);

    expect(() => insertItem(9)).toThrow(/outside its criterion/); // above the 1..5 scale
    expect(() => insertItem(5)).not.toThrow(); // in range
    expect(() => insertItem(0)).toThrow(/outside its criterion/); // below the scale
  });
});
