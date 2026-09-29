import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * The migration tests build a database as an old portal had it: the drizzle folder cut after migration `lastIdx`.
 * runMigrations then re-asserts today's src/server/db/triggers.ts, which that portal never had. A trigger that only a
 * later migration makes comes off again here: 0017's post-publish freeze reads `events`, which 0016 rebuilds and
 * renames, and a rename fails on a trigger whose body names a table that is gone for the moment. A real portal never
 * meets that: its boot asserts the triggers after all the migrations.
 */
export function dropLaterTriggers(sqlite: Database.Database, lastIdx: number) {
  const src = path.join(process.cwd(), "drizzle");
  const journal = JSON.parse(fs.readFileSync(path.join(src, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const made = (entries: { tag: string }[]) =>
    new Set(entries.flatMap((e) => [...fs.readFileSync(path.join(src, `${e.tag}.sql`), "utf8").matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)/g)].map((m) => m[1]!)));
  const then = made(journal.entries.filter((e) => e.idx <= lastIdx));
  for (const name of made(journal.entries.filter((e) => e.idx > lastIdx))) if (!then.has(name)) sqlite.exec(`DROP TRIGGER IF EXISTS ${name}`);
}
