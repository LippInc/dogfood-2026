import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";

// scripts/backup.mjs and scripts/restore.mjs, run as an operator runs them: a
// backup of a live, seeded database; a change made after it; a restore that brings
// the database back to the backup and drops the old write-ahead log.

let dir: string;
let dbPath: string;

function run(script: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [path.join(process.cwd(), "scripts", script), ...args], {
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

const count = (file: string, sql: string) => {
  const h = openDatabase(file);
  try {
    return (h.sqlite.prepare(sql).get() as { n: number }).n;
  } finally {
    h.sqlite.close();
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dogfood-backup-"));
  dbPath = path.join(dir, "portal.db");
  const h = openDatabase(dbPath);
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: "2026-09-26T12:00:00.000Z" });
  h.sqlite.close();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("backup and restore", () => {
  it("backs up a live database, then restores it over later changes and a write-ahead log left by a crash", () => {
    const users = count(dbPath, "SELECT count(*) AS n FROM users");
    const backup = run("backup.mjs", [path.join(dir, "backups")]);
    expect(backup.code, backup.out).toBe(0);
    const file = backup.out.trim().split(/\s+/)[0]!;
    expect(fs.existsSync(file)).toBe(true);
    expect(backup.out).toContain("integrity ok");
    expect(count(file, "SELECT count(*) AS n FROM users")).toBe(users);

    // a change after the backup, caught in the write-ahead log as a crash would leave it
    const live = openDatabase(dbPath);
    live.sqlite.pragma("wal_autocheckpoint = 0");
    live.sqlite
      .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_late', 'late@example.org', 'Late', NULL, 0, '2026-09-27T00:00:00.000Z')")
      .run();
    const leftover = path.join(dir, "leftover-wal");
    fs.copyFileSync(`${dbPath}-wal`, leftover);
    live.sqlite.close();

    // known-bad: copying the backup over the file and keeping that log replays the later change
    const naive = path.join(dir, "naive.db");
    fs.copyFileSync(file, naive);
    fs.copyFileSync(leftover, `${naive}-wal`);
    expect(count(naive, "SELECT count(*) AS n FROM users")).toBe(users + 1);

    fs.copyFileSync(leftover, `${dbPath}-wal`);
    const restore = run("restore.mjs", [file]);
    expect(restore.code, restore.out).toBe(0);
    expect(count(dbPath, "SELECT count(*) AS n FROM users")).toBe(users);
  });

  it("known-bad: a damaged backup is refused and the database is left as it was", () => {
    const users = count(dbPath, "SELECT count(*) AS n FROM users");
    const bad = path.join(dir, "damaged.db");
    fs.writeFileSync(bad, "not a database");
    const restore = run("restore.mjs", [bad]);
    expect(restore.code).not.toBe(0);
    expect(count(dbPath, "SELECT count(*) AS n FROM users")).toBe(users);
  });

  it("known-bad: no database to back up is an error, not an empty backup", () => {
    dbPath = path.join(dir, "missing.db");
    const backup = run("backup.mjs", [path.join(dir, "backups")]);
    expect(backup.code).toBe(2);
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });
});
