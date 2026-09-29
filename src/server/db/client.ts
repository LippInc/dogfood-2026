import "server-only";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
/** A Drizzle transaction handle; every write in the app runs inside one. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type Handle = { sqlite: Database.Database; db: Db; file: string };

export function databasePath(): string {
  return process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "portal.db");
}

/** Open a database file (or ":memory:") with the pragmas the app relies on. */
export function openDatabase(file: string): Handle {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // a REPLACE deletes the row it replaces; with this on, that delete fires the DELETE triggers too, so an
  // INSERT OR REPLACE cannot rewrite a published score, weight or assignment past the freeze (no trigger writes rows)
  sqlite.pragma("recursive_triggers = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return { sqlite, db: drizzle(sqlite, { schema }), file };
}

let current: Handle | null = null;

/**
 * The process-wide handle. It opens lazily on the first query, so `next build`
 * never touches /data.
 */
export function handle(): Handle {
  if (!current) current = openDatabase(databasePath());
  return current;
}

export function getDb(): Db {
  return handle().db;
}

/** The handle if one is open, without opening one. */
export function currentHandle(): Handle | null {
  return current;
}

const probes = new Map<string, { at: number; problem: string | null }>();

/**
 * Why the folder the database lives in cannot take a write, or null. A full or read-only volume keeps every read
 * working while every write fails, so the health check writes (and fsyncs) a 4 KB file there and deletes it. The
 * answer is kept for 30 s (a failure for 5 s, so a fixed volume shows soon), so a monitor polling the health check
 * costs at most one small write per half minute. An in-memory database has nothing to probe.
 */
export function dataFolderProblem(h: Handle, now = Date.now()): string | null {
  if (h.file === ":memory:") return null;
  const dir = path.dirname(h.file);
  const cached = probes.get(dir);
  if (cached && now - cached.at < (cached.problem ? 5_000 : 30_000)) return cached.problem;
  const file = path.join(dir, ".health-probe");
  let problem: string | null = null;
  try {
    const fd = fs.openSync(file, "w");
    try {
      fs.writeSync(fd, Buffer.alloc(4096));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.unlinkSync(file);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    const why = code === "ENOSPC" ? "it is full" : code === "EROFS" ? "it is read-only" : code === "EACCES" || code === "EPERM" ? "the portal may not write there" : "a test write failed";
    problem = `the data folder ${dir} cannot be written (${code}: ${why}); every change would fail`;
  }
  probes.set(dir, { at: now, problem });
  return problem;
}

/** Tests swap in an in-memory database. */
export function setHandleForTests(h: Handle | null): void {
  current = h;
}
