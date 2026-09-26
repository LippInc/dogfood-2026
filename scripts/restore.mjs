// Put a backup back in place. Stop the portal first; with the stack stopped, run:
//
//   docker compose run --rm --no-deps portal node scripts/restore.mjs /data/backups/portal-<time>.db
//
// It checks the backup, replaces DATABASE_PATH (default /data/portal.db) with it,
// and removes the old write-ahead log files, which belong to the replaced database
// and would corrupt the restored one if SQLite replayed them. The next start runs
// any newer migrations on it as usual.
import Database from "better-sqlite3";
import fs from "node:fs";

const backup = process.argv[2];
const target = process.env.DATABASE_PATH ?? "/data/portal.db";
if (!backup || !fs.existsSync(backup)) {
  console.error("Usage: node scripts/restore.mjs <backup file>");
  process.exit(2);
}
const check = new Database(backup, { readonly: true, fileMustExist: true });
const ok = check.pragma("integrity_check", { simple: true });
const rows = check.prepare("SELECT count(*) AS n FROM audit_log").get().n;
check.close();
if (ok !== "ok") {
  console.error(`Not restoring: the backup's integrity check says: ${ok}`);
  process.exit(1);
}
for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${target}${suffix}`, { force: true });
fs.copyFileSync(backup, target);
console.log(`Restored ${backup} to ${target} (${rows} audit rows). Start the portal again.`);
