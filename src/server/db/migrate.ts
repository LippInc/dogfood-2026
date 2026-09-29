import "server-only";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Handle } from "./client";
import { assertTriggers, type TriggerReport } from "./triggers";

export function migrationsFolder(): string {
  return process.env.MIGRATIONS_PATH ?? path.join(process.cwd(), "drizzle");
}

/**
 * Apply pending migrations, then re-assert every trigger. Synchronous.
 *
 * Foreign-key enforcement is off while the migrator runs, as SQLite's own recipe for rebuilding a table asks
 * (drizzle/0015_constraints.sql rebuilds tables other tables point at; with enforcement on, dropping the old
 * table fails as soon as rows reference it). The migrator runs everything inside one transaction, where a
 * PRAGMA foreign_keys does nothing, so it is switched here, outside it. Afterwards PRAGMA foreign_key_check
 * must find nothing: a migration that left a dangling reference stops the boot rather than serving it.
 */
export function runMigrations(h: Handle, folder = migrationsFolder()): TriggerReport {
  const enforced = h.sqlite.pragma("foreign_keys", { simple: true }) === 1;
  h.sqlite.pragma("foreign_keys = OFF");
  try {
    migrate(h.db, { migrationsFolder: folder });
  } finally {
    if (enforced) h.sqlite.pragma("foreign_keys = ON");
  }
  const dangling = h.sqlite.pragma("foreign_key_check") as { table: string; rowid: number; parent: string }[];
  if (dangling.length > 0) {
    const first = dangling[0]!;
    throw new Error(
      `after the migrations, ${dangling.length} row(s) point at a missing row (first: ${first.table} rowid ${first.rowid} -> ${first.parent})`,
    );
  }
  return assertTriggers(h.sqlite);
}
