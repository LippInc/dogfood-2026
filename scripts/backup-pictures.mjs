// The backup's picture check (scripts/backup.mjs): every picture the copied database names must be in the
// copied uploads folder. The database is copied first and the pictures after, and replacing a project's
// picture deletes the old file once the row has changed; so a picture replaced between the two steps
// leaves the copied rows naming a file the copied folder does not have, and a restore would lose it.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// the names the portal gives uploaded pictures (src/server/uploads.ts UPLOAD_PATH)
const UPLOAD_REF = /\/uploads\/([A-Za-z0-9_-]{22}\.(?:png|jpg|webp))$/;

/** Every uploaded picture a database's projects name, as their picture or in their gallery. */
export function namedPictures(dbFile) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const named = new Set();
    for (const r of db.prepare("SELECT thumbnail_url AS thumb, gallery_urls AS gallery FROM projects").all()) {
      let gallery = [];
      try {
        gallery = JSON.parse(r.gallery ?? "[]");
      } catch {
        gallery = [];
      }
      for (const url of [r.thumb ?? "", ...(Array.isArray(gallery) ? gallery : [])]) {
        const m = typeof url === "string" ? UPLOAD_REF.exec(url) : null;
        if (m) named.add(m[1]);
      }
    }
    return named;
  } finally {
    db.close();
  }
}

/**
 * Make the copied uploads hold every picture the copied database names. A missing one that is still in the
 * live folder is copied now. One gone from the live folder too either changed during the backup (the live
 * database no longer names it): the backup fails, to be run again; or was already missing from the live
 * portal (its database still names it): a backup cannot bring it back, so it is reported, not failed on.
 * Returns the names copied late and the names already missing.
 */
export function completePictures({ copyDb, copyUploads, liveUploads, liveDb }) {
  const named = namedPictures(copyDb);
  const copied = [];
  const alreadyMissing = [];
  let liveNamed = null;
  for (const name of [...named].sort()) {
    if (fs.existsSync(path.join(copyUploads, name))) continue;
    const live = path.join(liveUploads, name);
    if (fs.existsSync(live)) {
      fs.mkdirSync(copyUploads, { recursive: true });
      fs.copyFileSync(live, path.join(copyUploads, name));
      copied.push(name);
      continue;
    }
    liveNamed ??= namedPictures(liveDb);
    if (!liveNamed.has(name)) throw new Error("a picture changed during the backup, run it again");
    alreadyMissing.push(name);
  }
  return { copied, alreadyMissing };
}
