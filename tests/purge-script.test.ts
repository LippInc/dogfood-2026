import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { verifyAuditChain } from "@/server/audit";

// scripts/purge.mjs, run as an operator runs it: a dry run changes nothing; --yes removes old mail and finished
// webhook deliveries, the address hashes of a closed vote, ended sessions and idle buckets, and nothing else.

let dir: string;
let dbPath: string;

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [path.join(process.cwd(), "scripts", "purge.mjs"), ...args], {
      env: { ...process.env, DATABASE_PATH: dbPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

function withDb<T>(fn: (h: ReturnType<typeof openDatabase>) => T): T {
  const h = openDatabase(dbPath);
  try {
    return fn(h);
  } finally {
    h.sqlite.close();
  }
}

const n = (sql: string) => withDb((h) => (h.sqlite.prepare(sql).get() as { n: number }).n);
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-purge-"));
  dbPath = path.join(dir, "portal.db");
  withDb((h) => {
    runMigrations(h, path.join(process.cwd(), "drizzle"));
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: "2026-09-26T12:00:00.000Z" });
    const s = h.sqlite;
    s.prepare("UPDATE events SET voting_open_at = ?, voting_close_at = ? WHERE id = 'evt_01'").run(ago(10), new Date(Date.now() + DAY).toISOString());
    const mail = s.prepare("INSERT INTO outbox (id, event_id, kind, to_email, subject, body, status, created_at, sent_at) VALUES (?, 'evt_01', 'voter_link', ?, 'Your link', 'Vote here: [link removed]', 'sent', ?, ?)");
    mail.run("out_old", "old.person@example.org", ago(120), ago(120));
    mail.run("out_new", "new.person@example.org", ago(5), ago(5));
    s.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_p', 'p@example.org', 'P', NULL, 0, ?)").run(ago(30));
    s.prepare("INSERT INTO webhooks (id, event_id, url, secret, actions, created_at, created_by) VALUES ('wh_1', 'evt_01', 'https://example.org/hook', 's3cret', '[]', ?, 'usr_p')").run(ago(200));
    const hook = s.prepare("INSERT INTO webhook_deliveries (id, webhook_id, action, payload, status, created_at) VALUES (?, 'wh_1', 'vote.cast', '{\"actor\":\"Old Name\"}', ?, ?)");
    hook.run("whd_old_done", "delivered", ago(120));
    hook.run("whd_old_failed", "failed", ago(120));
    hook.run("whd_old_pending", "pending", ago(120));
    hook.run("whd_new_done", "delivered", ago(5));
    s.prepare("INSERT INTO voters (id, event_id, kind, token_hash, order_seed, ip_hash, agent_hash, created_at) VALUES ('vtr_1', 'evt_01', 'link', 'th1', 1, 'iphash', 'agenthash', ?)").run(ago(3));
    const session = s.prepare("INSERT INTO sessions (token_hash, user_id, kind, created_at, expires_at) VALUES (?, 'usr_p', 'login', ?, ?)");
    session.run("sess_ended", ago(20), ago(6));
    session.run("sess_live", ago(1), new Date(Date.now() + 13 * DAY).toISOString());
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scripts/purge.mjs", { timeout: 30_000 }, () => {
  it("a dry run lists what it would remove and changes nothing", () => {
    const before = [n("SELECT count(*) AS n FROM outbox"), n("SELECT count(*) AS n FROM webhook_deliveries"), n("SELECT count(*) AS n FROM sessions")];
    const r = run([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/would remove\s+1\s+mail log/);
    expect(r.out).toMatch(/would remove\s+2\s+finished webhook deliveries/);
    expect(r.out).toMatch(/dry run/);
    expect([n("SELECT count(*) AS n FROM outbox"), n("SELECT count(*) AS n FROM webhook_deliveries"), n("SELECT count(*) AS n FROM sessions")]).toEqual(before);
  });

  it("--yes removes old mail and finished deliveries, ended sessions; keeps new rows, pending deliveries, an open vote's hashes and the audit chain", () => {
    const auditRows = n("SELECT count(*) AS n FROM audit_log");
    const r = run(["--yes"]);
    expect(r.code, r.out).toBe(0);
    const ids = (sql: string) => withDb((h) => (h.sqlite.prepare(sql).all() as { id: string }[]).map((x) => x.id).sort());
    expect(ids("SELECT id FROM outbox")).toEqual(["out_new"]);
    expect(ids("SELECT id FROM webhook_deliveries")).toEqual(["whd_new_done", "whd_old_pending"]);
    expect(ids("SELECT token_hash AS id FROM sessions WHERE kind = 'login'")).toEqual(["sess_live"]);
    // the vote is still open: its flags still need the hashes
    expect(n("SELECT count(*) AS n FROM voters WHERE ip_hash IS NOT NULL")).toBe(1);
    expect(n("SELECT count(*) AS n FROM audit_log")).toBe(auditRows);
    expect(withDb((h) => verifyAuditChain(h.db).ok)).toBe(true);
    expect(n("SELECT count(*) AS n FROM users WHERE id = 'usr_p'")).toBe(1);
  });

  it("once the vote has closed, --yes blanks its voters' address and browser hashes (known-bad: they stayed for good)", () => {
    withDb((h) => h.sqlite.prepare("UPDATE events SET voting_close_at = ? WHERE id = 'evt_01'").run(ago(1)));
    expect(run(["--yes"]).code).toBe(0);
    expect(n("SELECT count(*) AS n FROM voters WHERE ip_hash IS NOT NULL OR agent_hash IS NOT NULL")).toBe(0);
    expect(n("SELECT count(*) AS n FROM voters")).toBe(1); // the voter, and so the ballot, stays
  });

  it("--days sets the age; a bad argument is refused with the usage and changes nothing", () => {
    expect(run(["--days", "abc"]).code).toBe(2);
    expect(run(["--everything"]).code).toBe(2);
    expect(n("SELECT count(*) AS n FROM outbox")).toBe(2);
    expect(run(["--days", "1", "--yes"]).code).toBe(0);
    expect(n("SELECT count(*) AS n FROM outbox")).toBe(0);
  });
});
