import "server-only";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Handle } from "./client";
import { assertTriggers, type TriggerReport } from "./triggers";

export function migrationsFolder(): string {
  return process.env.MIGRATIONS_PATH ?? path.join(process.cwd(), "drizzle");
}

/** Apply pending migrations, then re-assert every trigger. Synchronous. */
export function runMigrations(h: Handle, folder = migrationsFolder()): TriggerReport {
  migrate(h.db, { migrationsFolder: folder });
  return assertTriggers(h.sqlite);
}
