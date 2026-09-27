import { execFile, execFileSync } from "node:child_process";
import http from "node:http";
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
      env: { ...process.env, DATABASE_PATH: dbPath, PORTAL_HEALTH_URL: "http://127.0.0.1:9/api/health" },
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

// Each test runs the scripts as child processes, synchronously: well under a second
// alone, but past the default 5 s when the whole suite loads the machine.
describe("backup and restore", { timeout: 30_000 }, () => {
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

  it("known-bad: a restore while the portal still answers is refused and changes nothing", async () => {
    const users = count(dbPath, "SELECT count(*) AS n FROM users");
    const backup = run("backup.mjs", [path.join(dir, "backups")]);
    const file = backup.out.trim().split(/\s+/)[0]!;
    const server = http.createServer((_req, res) => res.end("{}"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const code = await new Promise<number>((resolve) => {
        const child = execFile(process.execPath, [path.join(process.cwd(), "scripts", "restore.mjs"), file], {
          env: { ...process.env, DATABASE_PATH: dbPath, PORTAL_HEALTH_URL: `http://127.0.0.1:${port}/api/health` },
        });
        child.on("exit", (c) => resolve(c ?? -1));
      });
      expect(code).toBe(3);
    } finally {
      server.close();
    }
    expect(count(dbPath, "SELECT count(*) AS n FROM users")).toBe(users);
  });

  it("without DATABASE_PATH both scripts use the portal's own default, ./data/portal.db", () => {
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, "data"), { recursive: true });
    fs.copyFileSync(dbPath, path.join(home, "data", "portal.db"));
    const env: NodeJS.ProcessEnv = { ...process.env, PORTAL_HEALTH_URL: "http://127.0.0.1:9/api/health" };
    delete env.DATABASE_PATH;
    const script = (name: string, args: string[]) =>
      execFileSync(process.execPath, [path.join(process.cwd(), "scripts", name), ...args], { cwd: home, env, encoding: "utf8" });
    const out = script("backup.mjs", []);
    const file = out.trim().split(/\s+/)[0]!;
    expect(file.startsWith(path.join(home, "data", "backups"))).toBe(true);
    expect(script("restore.mjs", [file])).toContain(path.join(home, "data", "portal.db"));
  });

  it("known-bad: no database to back up is an error, not an empty backup", () => {
    dbPath = path.join(dir, "missing.db");
    const backup = run("backup.mjs", [path.join(dir, "backups")]);
    expect(backup.code).toBe(2);
    expect(fs.existsSync(path.join(dir, "backups"))).toBe(false);
  });
});
