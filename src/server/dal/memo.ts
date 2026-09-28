import "server-only";
import type Database from "better-sqlite3";
import { currentHandle, type DbOrTx } from "../db/client";

// The engines are pure: the same rows give the same run. So a run is kept and reused
// until the data changes, measured by the database itself:
//   total_changes()  every row this connection has inserted, updated or deleted since it
//                    opened, triggers included (the app has one connection per process);
//   data_version     changes when another connection commits (a second process on the file).
// Inside a transaction nothing is kept or reused: a transaction may write and then roll
// back, and a run computed from rows that never committed must not outlive it.

type Entry = { version: string; value: unknown };
const caches = new WeakMap<Database.Database, Map<string, Entry>>();
const versionStatements = new WeakMap<Database.Database, Database.Statement>();

/** How many runs were computed rather than reused, for the scale test. */
export const memoStats = { computed: 0, reused: 0 };

function dataVersion(sqlite: Database.Database): string {
  let stmt = versionStatements.get(sqlite);
  if (!stmt) {
    stmt = sqlite.prepare("select total_changes() as changes, (select data_version from pragma_data_version) as version");
    versionStatements.set(sqlite, stmt);
  }
  const row = stmt.get() as { changes: number; version: number };
  return `${row.version}:${row.changes}`;
}

/** `compute()` once per key and data version; outside a transaction on the app's own handle only. */
export function memoByData<T>(db: DbOrTx, key: string, compute: () => T): T {
  const h = currentHandle();
  if (!h || db !== h.db || h.sqlite.inTransaction) {
    memoStats.computed++;
    return compute();
  }
  let cache = caches.get(h.sqlite);
  if (!cache) {
    cache = new Map();
    caches.set(h.sqlite, cache);
  }
  const version = dataVersion(h.sqlite);
  const hit = cache.get(key);
  if (hit && hit.version === version) {
    memoStats.reused++;
    return hit.value as T;
  }
  memoStats.computed++;
  const value = compute();
  // Computing reads only; if it wrote, what it read is already stale, so keep nothing.
  if (dataVersion(h.sqlite) === version) cache.set(key, { version, value });
  return value;
}
