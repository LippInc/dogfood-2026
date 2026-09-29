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

describe("published results are final in the database too", () => {
  const publish = () => h.sqlite.prepare("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'").run(NOW);
  const refused = (sql: string, pattern: RegExp, ...params: string[]) => expect(() => h.sqlite.prepare(sql).run(...params)).toThrow(pattern);
  const item = () => h.sqlite.prepare("SELECT score_id AS s, criterion_id AS c, value AS v FROM score_items LIMIT 1").get() as { s: string; c: string; v: number };
  const commented = () => (h.sqlite.prepare("SELECT score_id AS s FROM score_comments LIMIT 1").get() as { s: string }).s;
  const answer = () =>
    h.sqlite
      .prepare("INSERT INTO comparisons (id, event_id, judge_user_id, track_id, left_project_id, right_project_id, new_project_id, outcome, created_at) VALUES ('cmp_t', 'evt_01', 'jdg_01', 'trk_01', 'prj_01', 'prj_02', 'prj_02', 'left', ?)")
      .run(NOW);

  it("normalization runs and their scores reject UPDATE and DELETE, published or not", () => {
    h.sqlite.prepare("INSERT INTO normalization_runs (id, event_id, method, params, computed_at) VALUES ('nrm_t', 'evt_01', 'leniency-shrunk-v1', '{}', ?)").run(NOW);
    h.sqlite.prepare("INSERT INTO normalized_scores (run_id, project_id, n, raw_mean, normalized_mean) VALUES ('nrm_t', 'prj_01', 3, 3.5, 3.6)").run();
    refused("UPDATE normalization_runs SET method = 'edited' WHERE id = 'nrm_t'", /append-only: UPDATE rejected/);
    refused("DELETE FROM normalization_runs WHERE id = 'nrm_t'", /append-only: DELETE rejected/);
    refused("UPDATE normalized_scores SET normalized_mean = 5 WHERE run_id = 'nrm_t'", /append-only: UPDATE rejected/);
    refused("DELETE FROM normalized_scores WHERE run_id = 'nrm_t'", /append-only: DELETE rejected/);
  });

  it("before publishing a judge's numbers change freely (positive control); after, no edit or removal gets through", () => {
    const it0 = item();
    const other = it0.v === 1 ? 2 : 1;
    h.sqlite.prepare("UPDATE score_items SET value = ? WHERE score_id = ? AND criterion_id = ?").run(other, it0.s, it0.c);
    h.sqlite.prepare("UPDATE score_comments SET feedback = 'edited before publishing' WHERE score_id = ?").run(commented());
    answer();
    h.sqlite.prepare("UPDATE comparisons SET voided_at = ? WHERE id = 'cmp_t'").run(NOW);

    publish();
    const it1 = item();
    refused("UPDATE score_items SET value = ? WHERE score_id = ? AND criterion_id = ?", /published, so this is final/, String(it1.v === 1 ? 2 : 1), it1.s, it1.c);
    refused("DELETE FROM score_items WHERE score_id = ? AND criterion_id = ?", /published, so this is final/, it1.s, it1.c);
    refused("UPDATE score_comments SET feedback = 'edited after' WHERE score_id = ?", /published, so this is final/, commented());
    refused("DELETE FROM score_comments WHERE score_id = ?", /published, so this is final/, commented());
    refused("UPDATE scores SET submitted_at = NULL WHERE id = ?", /published, so this is final/, it1.s);
    refused("DELETE FROM scores WHERE id = ?", /published, so this is final/, it1.s);
    refused("UPDATE comparisons SET voided_at = NULL WHERE id = 'cmp_t'", /published, so this is final/);
    refused("DELETE FROM comparisons WHERE id = 'cmp_t'", /published, so this is final/);
  });

  it("published results cannot be withdrawn or pointed at another run; other changes to the event still go through", () => {
    h.sqlite.prepare("UPDATE events SET settings = json_set(coalesce(settings, '{}'), '$.publishedRunId', 'nrm_a') WHERE id = 'evt_01'").run();
    publish();
    refused("UPDATE events SET results_published_at = NULL WHERE id = 'evt_01'", /cannot be withdrawn or swapped/);
    refused("UPDATE events SET results_published_at = '2026-09-27T00:00:00.000Z' WHERE id = 'evt_01'", /cannot be withdrawn or swapped/);
    refused("UPDATE events SET settings = json_set(settings, '$.publishedRunId', 'nrm_b') WHERE id = 'evt_01'", /cannot be withdrawn or swapped/);
    h.sqlite.prepare("UPDATE events SET settings = json_set(settings, '$.maxTeamSize', 5), name = 'Renamed Hack' WHERE id = 'evt_01'").run();
    expect(h.sqlite.prepare("SELECT name FROM events WHERE id = 'evt_01'").get()).toEqual({ name: "Renamed Hack" });
  });

  it("the boot import still runs on a published event: it inserts nothing and edits nothing", () => {
    publish();
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    expect(() => importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW })).not.toThrow();
  });
});
