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
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("synchronous = NORMAL");
  return { sqlite, db: drizzle(sqlite, { schema }), file };
}

let current: Handle | null = null;

/**
 * The process-wide handle. It opens lazily on the first query, so `next build`
 * never touches /data (BUILD-PLAN decision 8).
 */
export function handle(): Handle {
  if (!current) current = openDatabase(databasePath());
  return current;
}

export function getDb(): Db {
  return handle().db;
}

/** Tests swap in an in-memory database. */
export function setHandleForTests(h: Handle | null): void {
  current = h;
}
