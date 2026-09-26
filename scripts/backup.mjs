// Back up the portal's database while it runs: SQLite's online backup, so the copy
// is consistent even mid-write. Inside the container:
//
//   docker compose exec portal node scripts/backup.mjs
//
// writes /data/backups/portal-<UTC time>.db and prints its path; copy it out with
// `docker compose cp portal:<path> .`. Uses DATABASE_PATH (default /data/portal.db).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const source = process.env.DATABASE_PATH ?? "/data/portal.db";
if (!fs.existsSync(source)) {
  console.error(`No database at ${source}.`);
  process.exit(2);
}
const dir = process.argv[2] ?? path.join(path.dirname(source), "backups");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const target = path.join(dir, `portal-${stamp}.db`);

const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(target);
} finally {
  db.close();
}
const copy = new Database(target, { readonly: true });
const ok = copy.pragma("integrity_check", { simple: true });
const rows = copy.prepare("SELECT count(*) AS n FROM audit_log").get().n;
copy.close();
if (ok !== "ok") {
  console.error(`Backup written to ${target}, but its integrity check says: ${ok}`);
  process.exit(1);
}
console.log(`${target}  (integrity ok, ${rows} audit rows)`);
