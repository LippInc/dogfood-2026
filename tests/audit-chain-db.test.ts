import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit, chainHash, GENESIS_HASH, verifyAuditChain } from "@/server/audit";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";

// The audit chain held by the database itself (src/server/db/triggers.ts, drizzle/0018_audit_chain.sql): a row goes
// in only at the end of the log and linked to the last row. Each refusal is shown with the trigger dropped too, where
// the same statement then gets through: that is the hole the trigger closes. The positive controls are the app's own
// appends (appendAudit), a tool's row that links correctly, the seed's import, and a writer that re-reads the head.

const DRIZZLE = path.join(process.cwd(), "drizzle");
const AT = "2026-09-29T08:00:00.000Z";
let dir: string;
let h: Handle;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-chain-"));
  h = openDatabase(path.join(dir, "portal.db"));
  runMigrations(h, DRIZZLE);
});

afterEach(() => {
  h.sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (n: number) => ({ actorUserId: null, actorLabel: "system", action: `test.row_${n}` });
const head = (db: Database.Database = h.sqlite) =>
  (db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined)?.hash ?? GENESIS_HASH;
const rows = () => h.sqlite.prepare("SELECT id, action, prev_hash AS prev, hash FROM audit_log ORDER BY id").all() as { id: number; action: string; prev: string; hash: string }[];

/** A row as a tool outside the app would write it, with the hash computed as the app computes it. */
function toolRow(prev: string, action: string) {
  const hash = chainHash(prev, { actorUserId: null, actorLabel: "tool", action, at: AT });
  return { prev, hash, action };
}
const INSERT = "INSERT INTO audit_log (at, actor_label, action, prev_hash, hash) VALUES (?, 'tool', ?, ?, ?)";
const insertWith = (db: Database.Database, verb: string, cols: string, values: (string | number)[]) =>
  db.prepare(`${verb} INTO audit_log (${cols}) VALUES (${values.map(() => "?").join(", ")})`).run(...values);

function appendThree() {
  appendAudit(h.db, entry(1), AT);
  h.db.transaction((tx) => {
    appendAudit(tx, entry(2), AT);
    appendAudit(tx, entry(3), AT);
  });
}

describe("the database keeps the audit chain linked", () => {
  it("positive control: the app's appends, in and out of one transaction, pass every trigger and the chain verifies", () => {
    appendThree();
    for (let i = 4; i <= 20; i++) appendAudit(h.db, entry(i), AT);
    const r = rows();
    expect(r).toHaveLength(20);
    expect(r[0]!.prev).toBe(GENESIS_HASH); // the trigger's genesis is audit.ts's GENESIS_HASH
    expect(verifyAuditChain(h.db)).toEqual({ ok: true, rows: 20, head: r.at(-1)!.hash });
  });

  it("the first row must link to 64 zeros: another start is refused, the genesis goes in", () => {
    const bad = toolRow("f".repeat(64), "tool.first");
    expect(() => h.sqlite.prepare(INSERT).run(AT, bad.action, bad.prev, bad.hash)).toThrow(/must link to the last row/);
    expect(rows()).toEqual([]);
    const good = toolRow(GENESIS_HASH, "tool.first");
    h.sqlite.prepare(INSERT).run(AT, good.action, good.prev, good.hash);
    expect(verifyAuditChain(h.db)).toEqual({ ok: true, rows: 1, head: good.hash });
  });

  it("known-bad: a row linked to an earlier row (a fork) is refused; linked to the last row it goes in", () => {
    appendThree();
    const [first] = rows();
    const fork = toolRow(first!.hash, "tool.fork");
    expect(() => h.sqlite.prepare(INSERT).run(AT, fork.action, fork.prev, fork.hash)).toThrow(/must link to the last row/);
    const linked = toolRow(head(), "tool.linked");
    h.sqlite.prepare(INSERT).run(AT, linked.action, linked.prev, linked.hash);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: true, rows: 4 });

    // without the rule the fork goes in, and only a full recomputation notices
    h.sqlite.exec("DROP TRIGGER audit_log_chain_link");
    const fork2 = toolRow(first!.hash, "tool.fork");
    h.sqlite.prepare(INSERT).run(AT, fork2.action, fork2.prev, fork2.hash);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: false, brokenAtId: 5 });
  });

  it("known-bad: INSERT OR REPLACE from a connection without recursive_triggers cannot rewrite a row, by id or by hash", () => {
    appendThree();
    const before = rows();
    const tool = new Database(path.join(dir, "portal.db")); // a plain sqlite connection: recursive_triggers is off
    try {
      expect(tool.pragma("recursive_triggers", { simple: true })).toBe(0);
      const last = before.at(-1)!;
      // the last row, rewritten in place: its link is right (the head before the statement), its id is taken
      const rewrite = toolRow(head(tool), "tool.rewritten");
      expect(() => insertWith(tool, "INSERT OR REPLACE", "id, at, actor_label, action, prev_hash, hash", [last.id, AT, "tool", rewrite.action, rewrite.prev, rewrite.hash])).toThrow(
        /a row with this id or hash is already there/,
      );
      // a new row whose hash is an earlier row's: REPLACE would delete that row to make room
      expect(() => insertWith(tool, "INSERT OR REPLACE", "at, actor_label, action, prev_hash, hash", [AT, "tool", "tool.same_hash", head(tool), before[0]!.hash])).toThrow(
        /a row with this id or hash is already there/,
      );
      expect(rows()).toEqual(before);

      // without the rule the REPLACE rewrites the last row, and its delete fires no DELETE trigger on this connection
      tool.exec("DROP TRIGGER audit_log_no_replace");
      insertWith(tool, "INSERT OR REPLACE", "id, at, actor_label, action, prev_hash, hash", [last.id, AT, "tool", rewrite.action, rewrite.prev, rewrite.hash]);
      expect(rows().at(-1)).toMatchObject({ id: last.id, action: "tool.rewritten" });
    } finally {
      tool.close();
    }
  });

  it("known-bad: an explicit id before the last row is refused; left to SQLite, the id follows the last", () => {
    appendThree();
    const early = toolRow(head(), "tool.early");
    expect(() => insertWith(h.sqlite, "INSERT", "id, at, actor_label, action, prev_hash, hash", [0, AT, "tool", early.action, early.prev, early.hash])).toThrow(
      /a new row goes after the last one/,
    );
    const late = toolRow(head(), "tool.late");
    insertWith(h.sqlite, "INSERT", "id, at, actor_label, action, prev_hash, hash", [100, AT, "tool", late.action, late.prev, late.hash]); // after the last: fine
    appendAudit(h.db, entry(4), AT);
    expect(rows().map((r) => r.id)).toEqual([1, 2, 3, 100, 101]);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: true, rows: 5 });

    // without the rule the row lands before the others and the chain breaks at it
    h.sqlite.exec("DROP TRIGGER audit_log_at_end");
    const early2 = toolRow(head(), "tool.early");
    insertWith(h.sqlite, "INSERT", "id, at, actor_label, action, prev_hash, hash", [0, AT, "tool", early2.action, early2.prev, early2.hash]);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: false, brokenAtId: 0 });
  });

  it("a writer that read the head before another connection appended cannot fork the chain; re-reading it, it can append", () => {
    appendThree();
    const other = openDatabase(path.join(dir, "portal.db"));
    try {
      const stale = toolRow(head(), "tool.stale"); // read here…
      appendAudit(other.db, entry(4), AT); // …then another writer appends
      expect(() => h.sqlite.prepare(INSERT).run(AT, stale.action, stale.prev, stale.hash)).toThrow(/must link to the last row/);
      const fresh = toolRow(head(), "tool.fresh");
      h.sqlite.prepare(INSERT).run(AT, fresh.action, fresh.prev, fresh.hash);
      appendAudit(other.db, entry(5), AT);
      expect(verifyAuditChain(h.db)).toMatchObject({ ok: true, rows: 6 });
    } finally {
      other.sqlite.close();
    }
  });

  it("the seed's fixture import writes its audit rows through the triggers, and importing again adds nothing", () => {
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: AT });
    const after = rows().length;
    expect(after).toBeGreaterThan(0);
    importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: AT });
    expect(rows()).toHaveLength(after);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: true, rows: after });
  });
});
