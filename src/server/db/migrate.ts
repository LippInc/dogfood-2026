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
  refuseRowsThatWouldDangle(h.sqlite);
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

/** The foreign keys drizzle/0015_constraints.sql adds to tables that had none on that column. */
const REFERENCES_0015 = [
  { table: "webhook_deliveries", column: "audit_id", parent: "audit_log", parentColumn: "id" },
  { table: "judge_invites", column: "created_by", parent: "users", parentColumn: "id" },
] as const;

type Sqlite = Handle["sqlite"];

/**
 * Before 0015 runs, refuse a database holding a row its new foreign keys would leave dangling. The CHECKs 0015
 * adds refuse such a row inside the migration, which then rolls back; the foreign keys cannot, because
 * enforcement is off while the migrator runs, so without this the migration would commit and every later boot
 * would stop at foreign_key_check with no way back but hand SQL. Only a hand-edited or restored database can
 * hold such a row: audit rows and users are never deleted. Nothing changes when this throws.
 */
export function refuseRowsThatWouldDangle(sqlite: Sqlite): void {
  const exists = (name: string) => sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  for (const ref of REFERENCES_0015) {
    if (!exists(ref.table) || !exists(ref.parent)) continue;
    const keys = sqlite.pragma(`foreign_key_list(${ref.table})`) as { table: string; from: string }[];
    if (keys.some((k) => k.table === ref.parent && k.from === ref.column)) continue; // 0015 already ran
    const rows = sqlite
      .prepare(
        `SELECT rowid AS rowid, "${ref.column}" AS value FROM "${ref.table}" WHERE "${ref.column}" IS NOT NULL AND "${ref.column}" NOT IN (SELECT "${ref.parentColumn}" FROM "${ref.parent}") ORDER BY rowid`,
      )
      .all() as { rowid: number; value: unknown }[];
    if (rows.length === 0) continue;
    const first = rows[0]!;
    throw new Error(
      `migration 0015 not run: ${rows.length} row(s) in ${ref.table} have a ${ref.column} with no matching ${ref.parent}.${ref.parentColumn} ` +
        `(first: rowid ${first.rowid}, ${ref.column} = ${JSON.stringify(first.value)}). The database is unchanged. ` +
        `Point each at a row that exists${ref.table === "webhook_deliveries" ? " or set it to NULL" : ""}, or restore a backup taken before the rows were edited, then start the portal again.`,
    );
  }
}
