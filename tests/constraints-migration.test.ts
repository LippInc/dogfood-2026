import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "@/server/audit";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { TRIGGERS } from "@/server/db/triggers";

// drizzle/0015_constraints.sql rebuilds nine tables to add CHECK constraints and foreign keys SQLite cannot add
// in place. These tests take a database as the portal had it before (migrations 0000 to 0014, with the fixture
// event and a row in every rebuilt table), migrate it, and check that every row survived, the triggers still
// guard, and each new constraint refuses a bad row while the matching good row goes in.

const DRIZZLE = path.join(process.cwd(), "drizzle");
const NOW = "2026-09-26T12:00:00.000Z";
const LATER = "2026-09-26T13:00:00.000Z";
const REBUILT = [
  "api_tokens",
  "comments",
  "events",
  "judge_invites",
  "judge_overrides",
  "normalization_runs",
  "scores",
  "voters",
  "webhook_deliveries",
];

let before0015: string;

beforeAll(() => {
  // the migrations folder as it was before 0015: the same files, the journal cut after 0014
  before0015 = fs.mkdtempSync(path.join(os.tmpdir(), "quality-before-0015-"));
  fs.mkdirSync(path.join(before0015, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 14);
  expect(journal.entries.at(-1)?.tag).toBe("0014_audit_salt");
  fs.writeFileSync(path.join(before0015, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) fs.copyFileSync(path.join(DRIZZLE, `${e.tag}.sql`), path.join(before0015, `${e.tag}.sql`));
});

afterAll(() => {
  fs.rmSync(before0015, { recursive: true, force: true });
});

let h: Handle;
const run = (sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).run(...args);
const one = <T>(sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).get(...args) as T;
const tableSql = (name: string) => one<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name).sql;
const dump = () => Object.fromEntries(REBUILT.map((t) => [t, h.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));

/** One row in every rebuilt table, each with its optional columns set, as the app writes them. */
function fillOldDatabase({ publish }: { publish: boolean }) {
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  const user = one<{ id: string }>("SELECT id FROM users ORDER BY id LIMIT 1").id;
  const project = one<{ id: string }>("SELECT id FROM projects WHERE event_id = 'evt_01' ORDER BY id LIMIT 1").id;
  run("UPDATE events SET voting_open_at = ?, voting_close_at = ?, judging_close_at = ? WHERE id = 'evt_01'", NOW, LATER, LATER);
  run(
    "INSERT INTO judge_invites (id, event_id, code_hash, name, email, track_ids, created_at, created_by, accepted_at, accepted_by) VALUES ('jiv_1', 'evt_01', 'h1', 'Ann', null, '[]', ?, ?, ?, ?)",
    NOW, user, LATER, user,
  );
  run(
    "INSERT INTO judge_overrides (id, event_id, judge_user_id, mode, reason, created_at, created_by, revoked_at, revoked_by) VALUES ('jov_1', 'evt_01', ?, 'exclude', 'flat scores', ?, ?, ?, ?)",
    user, NOW, user, LATER, user,
  );
  run(
    "INSERT INTO voters (id, event_id, kind, user_id, order_seed, created_at, last_voted_at, voided_at, voided_by, void_reason) VALUES ('vtr_1', 'evt_01', 'account', ?, 7, ?, ?, ?, ?, 'a duplicate')",
    user, NOW, NOW, LATER, user,
  );
  run(
    "INSERT INTO comments (id, event_id, project_id, user_id, body, created_at, hidden_at, hidden_by, hidden_reason) VALUES ('cmt_1', 'evt_01', ?, ?, 'Nice', ?, ?, ?, 'off topic')",
    project, user, NOW, LATER, user,
  );
  run(
    "INSERT INTO api_tokens (id, user_id, name, token_hash, hint, created_at, expires_at, last_used_at, revoked_at) VALUES ('tok_1', ?, 'script', 'th1', 'dfp_12345', ?, ?, ?, ?)",
    user, NOW, "2026-12-01T00:00:00.000Z", LATER, LATER,
  );
  run(
    "INSERT INTO normalization_runs (id, event_id, method, params, computed_at, computed_by) VALUES ('nrm_1', 'evt_01', 'leniency-shrunk-v1', '{}', ?, ?)",
    NOW, user,
  );
  appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: "test.before0015" }, NOW);
  const auditId = one<{ id: number }>("SELECT max(id) AS id FROM audit_log").id;
  run("INSERT INTO webhooks (id, event_id, url, secret, actions, created_at, created_by) VALUES ('whk_1', 'evt_01', 'https://example.test/h', 's', '[\"*\"]', ?, ?)", NOW, user);
  run(
    "INSERT INTO webhook_deliveries (id, webhook_id, audit_id, action, payload, status, attempts, next_attempt_at, last_attempt_at, created_at, delivered_at) VALUES ('dlv_1', 'whk_1', ?, 'test.before0015', '{}', 'delivered', 1, null, ?, ?, ?)",
    auditId, LATER, NOW, LATER,
  );
  // the event's results published last, so the published-results triggers have something to guard
  if (publish) run("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'", LATER);
  expect(one<{ n: number }>("SELECT count(*) AS n FROM scores").n).toBeGreaterThan(0);
}

describe("migration 0015 on a database that already holds data", () => {
  beforeEach(() => {
    h = openDatabase(":memory:");
    runMigrations(h, before0015);
    fillOldDatabase({ publish: true });
  });
  afterEach(() => h.sqlite.close());

  it("keeps every row of every rebuilt table, byte for byte", () => {
    const rows = dump();
    for (const t of REBUILT) expect(rows[t]!.length, t).toBeGreaterThan(0);
    runMigrations(h, DRIZZLE);
    expect(dump()).toEqual(rows);
    expect(tableSql("events")).toContain("events_voting_open_iso");
  });

  it("leaves no reference dangling, foreign keys enforced again, and names no temporary table", () => {
    runMigrations(h, DRIZZLE);
    expect(h.sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    const leftovers = h.sqlite.prepare("SELECT name FROM sqlite_master WHERE instr(sql, '__new_') > 0").all();
    expect(leftovers).toEqual([]);
  });

  it("makes every trigger again with triggers.ts's text, and they still guard the published event", () => {
    const report = runMigrations(h, DRIZZLE);
    expect(report).toEqual({ created: [], restored: [] });
    const names = (h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(Object.keys(TRIGGERS).sort());
    expect(() => run("UPDATE scores SET updated_at = ?", LATER)).toThrow(/results are published/);
    expect(() => run("DELETE FROM normalization_runs")).toThrow(/append-only/);
    expect(() => run("UPDATE events SET results_published_at = NULL WHERE id = 'evt_01'")).toThrow(/cannot be withdrawn/);
    expect(() => run("DELETE FROM audit_log")).toThrow(/append-only/);
  });

  it("refuses a database holding a row that breaks a new constraint, and leaves it as it was", () => {
    // written before 0015 existed: nothing stopped a malformed date then
    run("UPDATE comments SET created_at = 'yesterday' WHERE id = 'cmt_1'");
    const rows = dump();
    let caught: unknown;
    try {
      runMigrations(h, DRIZZLE);
    } catch (err) {
      caught = err;
    }
    // drizzle wraps the SQLite error; the cause names the constraint
    expect(String((caught as Error | undefined)?.cause)).toMatch(/CHECK constraint failed: comments_created_iso/);
    expect(dump()).toEqual(rows);
    expect(tableSql("comments")).not.toContain("comments_created_iso");
    expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  // The two new foreign keys cannot refuse inside the migration (enforcement is off while it runs), so
  // runMigrations looks for such rows first and refuses before anything changes.
  const dangling = [
    { table: "webhook_deliveries", sql: "UPDATE webhook_deliveries SET audit_id = 999999 WHERE id = 'dlv_1'", names: /webhook_deliveries .*audit_id = 999999/ },
    { table: "judge_invites", sql: "UPDATE judge_invites SET created_by = 'usr_gone' WHERE id = 'jiv_1'", names: /judge_invites .*created_by = "usr_gone"/ },
  ];
  for (const d of dangling) {
    it(`refuses a database whose ${d.table} row would dangle under 0015's foreign key, and leaves it as it was`, () => {
      run(d.sql);
      const rows = dump();
      const table = tableSql(d.table);
      const applied = one<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations").n;
      expect(() => runMigrations(h, DRIZZLE)).toThrow(d.names);
      expect(dump()).toEqual(rows);
      expect(tableSql(d.table)).toBe(table);
      expect(one<{ n: number }>("SELECT count(*) AS n FROM __drizzle_migrations").n).toBe(applied);
      expect(h.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  }

  it("migrates once the dangling row is pointed at a row that exists (positive control)", () => {
    run("UPDATE webhook_deliveries SET audit_id = NULL WHERE id = 'dlv_1'");
    expect(() => runMigrations(h, DRIZZLE)).not.toThrow();
    expect(tableSql("webhook_deliveries")).toContain("REFERENCES `audit_log`");
    // and a later boot, with 0015 applied, does not look again
    expect(() => runMigrations(h, DRIZZLE)).not.toThrow();
  });
});

describe("the constraints 0015 adds", () => {
  beforeEach(() => {
    h = openDatabase(":memory:");
    runMigrations(h, before0015);
    fillOldDatabase({ publish: false });
    run("UPDATE events SET voting_open_at = NULL, voting_close_at = NULL WHERE id = 'evt_01'");
    runMigrations(h, DRIZZLE);
  });
  afterEach(() => h.sqlite.close());

  // each case: the bad write, which fails on the named constraint, and the good one next to it, which passes
  const cases: [string, string, string][] = [
    ["events_voting_open_iso", "UPDATE events SET voting_open_at = 'soon' WHERE id = 'evt_01'", "UPDATE events SET voting_open_at = '2026-09-27T10:00:00.000Z' WHERE id = 'evt_01'"],
    ["events_voting_close_iso", "UPDATE events SET voting_close_at = 'later' WHERE id = 'evt_01'", "UPDATE events SET voting_close_at = '2026-09-28T10:00:00.000Z' WHERE id = 'evt_01'"],
    ["events_published_iso", "UPDATE events SET results_published_at = 'now-ish' WHERE id = 'evt_01'", "UPDATE events SET results_published_at = '2026-09-28T10:00:00.000Z' WHERE id = 'evt_01'"],
    ["events_judging_close_iso", "UPDATE events SET judging_close_at = 'friday' WHERE id = 'evt_01'", "UPDATE events SET judging_close_at = NULL WHERE id = 'evt_01'"],
    ["scores_submitted_at_iso", "UPDATE scores SET submitted_at = 'done'", "UPDATE scores SET submitted_at = '2026-09-26T14:00:00.000Z'"],
    ["voters_voided_iso", "UPDATE voters SET voided_at = 'x'", "UPDATE voters SET voided_at = '2026-09-26T14:00:00.000Z'"],
    ["voters_last_voted_iso", "UPDATE voters SET last_voted_at = 'x'", "UPDATE voters SET last_voted_at = NULL"],
    ["voters_voided_by", "UPDATE voters SET voided_by = NULL", "UPDATE voters SET voided_at = NULL, voided_by = NULL"],
    ["comments_hidden_iso", "UPDATE comments SET hidden_at = 'x'", "UPDATE comments SET hidden_at = '2026-09-26T14:00:00.000Z'"],
    ["comments_hidden_by", "UPDATE comments SET hidden_at = NULL", "UPDATE comments SET hidden_at = NULL, hidden_by = NULL"],
    ["judge_invites_accepted_iso", "UPDATE judge_invites SET accepted_at = 'x'", "UPDATE judge_invites SET accepted_at = '2026-09-26T14:00:00.000Z'"],
    ["judge_invites_accepted_by", "UPDATE judge_invites SET accepted_by = NULL", "UPDATE judge_invites SET accepted_at = NULL, accepted_by = NULL"],
    ["judge_invites_revoked_iso", "UPDATE judge_invites SET accepted_at = NULL, accepted_by = NULL, revoked_at = 'x'", "UPDATE judge_invites SET accepted_at = NULL, accepted_by = NULL, revoked_at = '2026-09-26T14:00:00.000Z'"],
    ["judge_overrides_revoked_by", "UPDATE judge_overrides SET revoked_by = NULL", "UPDATE judge_overrides SET revoked_at = NULL, revoked_by = NULL"],
    ["judge_overrides_revoked_iso", "UPDATE judge_overrides SET revoked_at = 'x'", "UPDATE judge_overrides SET revoked_at = '2026-09-26T14:00:00.000Z'"],
    ["judge_overrides_created_iso", "UPDATE judge_overrides SET created_at = 'x'", "UPDATE judge_overrides SET created_at = '2026-09-26T11:00:00.000Z'"],
    ["api_tokens_revoked_iso", "UPDATE api_tokens SET revoked_at = 'x'", "UPDATE api_tokens SET revoked_at = NULL"],
    ["api_tokens_last_used_iso", "UPDATE api_tokens SET last_used_at = 'x'", "UPDATE api_tokens SET last_used_at = '2026-09-26T14:00:00.000Z'"],
    ["api_tokens_expires_iso", "UPDATE api_tokens SET expires_at = 'x'", "UPDATE api_tokens SET expires_at = NULL"],
    ["webhook_deliveries_next_iso", "UPDATE webhook_deliveries SET next_attempt_at = 'x'", "UPDATE webhook_deliveries SET next_attempt_at = '2026-09-26T14:00:00.000Z'"],
    ["webhook_deliveries_delivered_iso", "UPDATE webhook_deliveries SET delivered_at = 'x'", "UPDATE webhook_deliveries SET delivered_at = NULL"],
  ];

  it.each(cases)("%s refuses the bad write and takes the good one", (constraint, bad, good) => {
    expect(() => run(bad)).toThrow(new RegExp(`CHECK constraint failed: ${constraint}`));
    expect(run(good).changes).toBeGreaterThan(0);
  });

  it("normalization_runs.method is one of the two engines", () => {
    const insert = (id: string, method: string) =>
      run("INSERT INTO normalization_runs (id, event_id, method, params, computed_at) VALUES (?, 'evt_01', ?, '{}', ?)", id, method, NOW);
    expect(() => insert("nrm_bad", "leniency-shrunk-v2")).toThrow(/CHECK constraint failed: normalization_runs_method/);
    expect(insert("nrm_bt", "bradley-terry-v1").changes).toBe(1);
    expect(() => run("INSERT INTO normalization_runs (id, event_id, method, params, computed_at) VALUES ('nrm_t', 'evt_01', 'leniency-shrunk-v1', '{}', 'x')")).toThrow(
      /CHECK constraint failed: normalization_runs_computed_iso/,
    );
  });

  it("a webhook delivery points at an audit row that exists", () => {
    expect(() => run("UPDATE webhook_deliveries SET audit_id = 999999")).toThrow(/FOREIGN KEY constraint failed/);
    expect(run("UPDATE webhook_deliveries SET audit_id = NULL").changes).toBe(1);
    const auditId = one<{ id: number }>("SELECT min(id) AS id FROM audit_log").id;
    expect(run("UPDATE webhook_deliveries SET audit_id = ?", auditId).changes).toBe(1);
    // and the reference does not stop the audit log's own triggers from refusing an edit
    expect(() => run("DELETE FROM audit_log WHERE id = ?", auditId)).toThrow(/append-only/);
  });

  it("a judge invite's maker is a user who exists", () => {
    expect(() => run("UPDATE judge_invites SET created_by = 'usr_nobody'")).toThrow(/FOREIGN KEY constraint failed/);
    const user = one<{ id: string }>("SELECT id FROM users ORDER BY id DESC LIMIT 1").id;
    expect(run("UPDATE judge_invites SET created_by = ?", user).changes).toBe(1);
  });
});
