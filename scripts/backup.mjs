// Back up the portal while it runs: the database with SQLite's online backup, so the copy
// is consistent even mid-write, and the uploaded pictures with it. Inside the container:
//
//   docker compose exec portal node scripts/backup.mjs
//
// writes the folder /data/backups/portal-<UTC time>/ (portal.db and uploads/) and prints
// its path; copy it off the volume with `docker compose cp portal:<path> .`, since a backup
// that stays on the volume goes with the volume. Only the newest BACKUP_KEEP backups (default
// 7) are kept there: older ones are deleted after each new one checks out. Uses DATABASE_PATH,
// with the portal's own default (./data/portal.db; the image sets /data/portal.db), and
// UPLOADS_DIR, by default uploads/ beside the database.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const source = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "portal.db");
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}.`);
  process.exit(2);
}
const keep = Number(process.env.BACKUP_KEEP ?? 7);
if (!Number.isInteger(keep) || keep < 1) {
  console.error(`BACKUP_KEEP must be a whole number of backups to keep, 1 or more (it is ${process.env.BACKUP_KEEP}).`);
  process.exit(2);
}
const uploads = process.env.UPLOADS_DIR ?? path.join(path.dirname(source), "uploads");
const dir = process.argv[2] ?? path.join(path.dirname(source), "backups");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const folder = path.join(dir, `portal-${stamp}`);
fs.mkdirSync(dir, { recursive: true });
try {
  fs.mkdirSync(folder);
} catch {
  console.error(`${folder} already exists (a backup made this second): run it again in a moment.`);
  process.exit(1);
}
const target = path.join(folder, "portal.db");

const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(target);
} finally {
  db.close();
}
// After the database, so every picture the copied rows name is there (a picture added since is one file more).
let pictures = 0;
if (fs.existsSync(uploads)) {
  fs.cpSync(uploads, path.join(folder, "uploads"), { recursive: true });
  pictures = fs.readdirSync(path.join(folder, "uploads")).length;
}
// One self-contained file: the copy keeps the live database's WAL mode, so opening it would leave -wal and -shm
// files beside it; a rollback journal leaves none.
const copy = new Database(target);
copy.pragma("journal_mode = DELETE");
const ok = copy.pragma("integrity_check", { simple: true });
const rows = copy.prepare("SELECT count(*) AS n FROM audit_log").get().n;
copy.close();
if (ok !== "ok") {
  console.error(`Backup written to ${folder}, but its integrity check says: ${ok}`);
  process.exit(1);
}

// Keep the newest `keep` backups in this folder: portal-<time> folders, and portal-<time>.db files from before
// backups were folders. The names sort by time.
const BACKUP_NAME = /^portal-\d{8}T\d{6}Z(\.db)?$/;
const all = fs
  .readdirSync(dir)
  .filter((n) => BACKUP_NAME.test(n))
  .sort();
const old = all.slice(0, Math.max(0, all.length - keep)).filter((n) => path.join(dir, n) !== folder);
for (const n of old) fs.rmSync(path.join(dir, n), { recursive: true, force: true });

console.log(
  `${folder}  (integrity ok, ${rows} audit rows, ${pictures} uploaded ${pictures === 1 ? "picture" : "pictures"}${old.length ? `; ${old.length} older ${old.length === 1 ? "backup" : "backups"} deleted, ${keep} kept` : ""})`,
);
