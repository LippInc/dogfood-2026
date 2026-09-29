import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { and, eq, ne, or, sql } from "drizzle-orm";
import { databasePath, type Db, type DbOrTx } from "./db/client";
import { projects } from "./db/schema";

// Uploaded project pictures: files in the data volume, next to the database, so `docker compose up`
// needs nothing else and a backup of /data holds them. A file's name is 128 random bits and the
// kind of image it is; what comes in is told by its bytes, never by a file name or a declared type,
// and what is stored is a WebP the portal drew itself (redrawImage), so only images ever come back
// out (no SVG, no HTML: nothing a browser would run).

/** 8 MB: a phone photo or a full-screen screenshot fits, and it stays under the 10 MB Next's proxy holds of a body. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export type ImageKind = "png" | "jpg" | "webp";
const TYPE: Record<ImageKind, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** A stored file's name: 22 base64url characters (16 random bytes) and its kind. */
export const UPLOAD_NAME = /^[A-Za-z0-9_-]{22}\.(png|jpg|webp)$/;
/** The address a stored file is served at, as a project keeps it. */
export const UPLOAD_PATH = /^\/uploads\/[A-Za-z0-9_-]{22}\.(png|jpg|webp)$/;

const at = (b: Uint8Array, i: number, text: string) => [...text].every((c, j) => b[i + j] === c.charCodeAt(0));

/** What kind of image the bytes are, from their first bytes alone; null for anything else. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 8 && b[0] === 0x89 && at(b, 1, "PNG") && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && at(b, 0, "RIFF") && at(b, 8, "WEBP")) return "webp";
  return null;
}

/** The longest side of a stored picture: the project page shows it at most 800 pixels wide, sharp on a 2x screen. */
export const MAX_IMAGE_SIDE = 1600;
/** Larger pictures are refused before they are decoded: 50 megapixels is past any phone camera's usual photo. */
export const MAX_IMAGE_PIXELS = 50_000_000;

export type Redrawn = { ok: true; bytes: Uint8Array } | { ok: false; why: "too_many_pixels" | "damaged" };

/**
 * The picture drawn again from its pixels, and nothing else. A phone photo carries where it was taken,
 * in places no list of them keeps up with (EXIF, XMP, a content-credentials record, a motion photo's
 * video after the image), and an upload here is public. So the pixels are decoded (the bytes were
 * already sniffed as PNG, JPEG or WebP, so only those decoders run), turned upright as the photo's
 * orientation tag says, converted to sRGB, scaled to at most 1600 pixels a side and written as a new
 * WebP file that holds nothing but them. An animation keeps its first frame.
 */
export async function redrawImage(b: Uint8Array): Promise<Redrawn> {
  try {
    const { width = 0, height = 0 } = await sharp(b).metadata();
    if (width * height > MAX_IMAGE_PIXELS) return { ok: false, why: "too_many_pixels" };
    const out = await sharp(b, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: "error" })
      .autoOrient()
      .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer();
    return { ok: true, bytes: new Uint8Array(out) };
  } catch {
    return { ok: false, why: "damaged" };
  }
}

/** The folder: UPLOADS_DIR, else `uploads` beside the database file. */
export function uploadsDir(): string {
  return process.env.UPLOADS_DIR ?? path.join(/*turbopackIgnore: true*/ path.dirname(databasePath()), "uploads");
}

/** Write the bytes under a new random name and return the name. The caller has checked kind and size. */
export function storeUpload(bytes: Uint8Array, kind: ImageKind): string {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomBytes(16).toString("base64url")}.${kind}`;
  // the ignore comments keep the build from tracing the whole project into the server bundle for these joins
  fs.writeFileSync(path.join(/*turbopackIgnore: true*/ dir, name), bytes, { flag: "wx" });
  return name;
}

/** Delete a stored file by its name or its /uploads/ address; anything else is left alone. */
export function discardUpload(nameOrPath: string | null | undefined): void {
  if (!nameOrPath) return;
  const name = nameOrPath.startsWith("/uploads/") ? nameOrPath.slice("/uploads/".length) : nameOrPath;
  if (!UPLOAD_NAME.test(name)) return;
  fs.rmSync(path.join(/*turbopackIgnore: true*/ uploadsDir(), name), { force: true });
}

/**
 * At start: delete stored pictures no project names any more. A picture's file is written before its row commits
 * and deleted after the row that named it changes, so a crash between the two leaves a file nothing points to, and
 * a database restored without its pictures leaves newer ones behind. Only files with an upload's own name are
 * touched. A database without a single project is left alone (a new or wrong database file next to an old
 * pictures folder must not empty it). Runs before the portal serves anything, so no upload is on its way.
 */
export function sweepOrphanUploads(db: Db, dir = uploadsDir()): { removed: number; kept: number; skipped?: string } {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => UPLOAD_NAME.test(n));
  } catch {
    return { removed: 0, kept: 0 };
  }
  if (names.length === 0) return { removed: 0, kept: 0 };
  const projectCount = db.select({ n: sql<number>`count(*)` }).from(projects).get()?.n ?? 0;
  if (projectCount === 0) return { removed: 0, kept: names.length, skipped: "the database has no project, so none of the pictures was removed" };
  // every /uploads/ address a project keeps, as its picture or among its links
  const named = new Set<string>();
  for (const r of db.select({ thumb: projects.thumbnailUrl, gallery: projects.galleryUrls }).from(projects).all()) {
    for (const url of [r.thumb ?? "", ...(r.gallery ?? [])]) {
      const m = /\/uploads\/([A-Za-z0-9_-]{22}\.(?:png|jpg|webp))$/.exec(url);
      if (m) named.add(m[1]);
    }
  }
  let removed = 0;
  for (const n of names) {
    if (named.has(n)) continue;
    fs.rmSync(path.join(/*turbopackIgnore: true*/ dir, n), { force: true });
    removed += 1;
  }
  return { removed, kept: names.length - removed };
}

/** Whether a project other than `projectId` shows this address, as its picture or in its gallery: its file is then kept. */
export function shownElsewhere(tx: DbOrTx, url: string, projectId: string): boolean {
  return Boolean(
    tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(ne(projects.id, projectId), or(eq(projects.thumbnailUrl, url), sql`exists (select 1 from json_each(${projects.galleryUrls}) where value = ${url})`)))
      .get(),
  );
}

/** A stored file and the type its name says, or null for a malformed name or a missing file. */
export function readUpload(name: string): { bytes: Buffer; type: string } | null {
  if (!UPLOAD_NAME.test(name)) return null;
  try {
    return { bytes: fs.readFileSync(path.join(/*turbopackIgnore: true*/ uploadsDir(), name)), type: TYPE[name.split(".").pop() as ImageKind] };
  } catch {
    return null;
  }
}
