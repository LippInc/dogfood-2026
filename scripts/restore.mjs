// Put a backup back in place. Stop the portal first; with the stack stopped, run:
//
//   docker compose run --rm --no-deps portal node scripts/restore.mjs /data/backups/portal-<time>
//
// It checks the backup, replaces DATABASE_PATH (the portal's own default,
// ./data/portal.db; the image sets /data/portal.db) with it, and removes the old
// write-ahead log files, which belong to the replaced database and would corrupt the
// restored one if SQLite replayed them. A backup folder (backup.mjs) also brings its
// uploaded pictures back: the pictures folder in use is moved aside, next to it, as
// uploads-before-restore-<time>, so nothing is lost. A lone .db file (an older backup)
// restores the database only: pictures added since stay on disk until the next start
// removes those no row names, and pictures removed since are gone. The next start runs
// any newer migrations on it as usual.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const given = process.argv[2];
const target = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "portal.db");
const uploads = process.env.UPLOADS_DIR ?? path.join(path.dirname(target), "uploads");
if (!given || !fs.existsSync(given)) {
  console.error("Usage: node scripts/restore.mjs <backup folder, or backup .db file>");
  process.exit(2);
}
const isFolder = fs.statSync(given).isDirectory();
const backup = isFolder ? path.join(given, "portal.db") : given;
if (!fs.existsSync(backup)) {
  console.error(`${given} is not a backup: it has no portal.db.`);
  process.exit(2);
}
const backupUploads = isFolder ? path.join(given, "uploads") : null;
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

let pictures = "";
if (backupUploads) {
  let aside = "";
  if (fs.existsSync(uploads)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    aside = path.join(path.dirname(uploads), `uploads-before-restore-${stamp}`);
    fs.renameSync(uploads, aside);
  }
  if (fs.existsSync(backupUploads)) fs.cpSync(backupUploads, uploads, { recursive: true });
  else fs.mkdirSync(uploads, { recursive: true });
  const n = fs.readdirSync(uploads).length;
  pictures = `; ${n} uploaded ${n === 1 ? "picture" : "pictures"} restored${aside ? `, the ones in use moved to ${aside} (delete it once the portal looks right)` : ""}`;
} else {
  pictures = "; uploaded pictures were not in this backup and are left as they are (the next start removes those no row names)";
}
console.log(`Restored ${given} to ${target} (${rows} audit rows, integrity ok${pictures}). Start the portal again.`);
