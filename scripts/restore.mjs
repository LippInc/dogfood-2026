// Put a backup back in place. Stop the portal first; with the stack stopped, run:
//
//   docker compose run --rm --no-deps portal node scripts/restore.mjs /data/backups/portal-<time>.db
//
// It checks the backup, replaces DATABASE_PATH (the portal's own default,
// ./data/portal.db; the image sets /data/portal.db) with it,
// and removes the old write-ahead log files, which belong to the replaced database
// and would corrupt the restored one if SQLite replayed them. The next start runs
// any newer migrations on it as usual.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const backup = process.argv[2];
const target = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "portal.db");
if (!backup || !fs.existsSync(backup)) {
  console.error("Usage: node scripts/restore.mjs <backup file>");
  process.exit(2);
}
// Overwriting the file under a running portal would corrupt the live database. In
// `docker compose run` the running service answers at http://portal:8080; outside
// Compose that name does not resolve and this check passes quickly.
const running = await fetch(process.env.PORTAL_HEALTH_URL ?? "http://portal:8080/api/health", { signal: AbortSignal.timeout(3000) }).then(
  () => true,
  () => false,
);
if (running) {
  console.error("The portal is still running: stop it first (docker compose stop), then run this again.");
  process.exit(3);
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
const placed = new Database(target, { readonly: true, fileMustExist: true });
const after = placed.pragma("integrity_check", { simple: true });
const placedRows = placed.prepare("SELECT count(*) AS n FROM audit_log").get().n;
placed.close();
if (after !== "ok" || placedRows !== rows) {
  console.error(`The copy at ${target} does not check out (integrity: ${after}, ${placedRows} of ${rows} audit rows). Do not start the portal on it.`);
  process.exit(1);
}
console.log(`Restored ${backup} to ${target} (${rows} audit rows, integrity ok). Start the portal again.`);
