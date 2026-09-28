import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { databasePath } from "./db/client";

// Uploaded project pictures: files in the data volume, next to the database, so `docker compose up`
// needs nothing else and a backup of /data holds them. A file's name is 128 random bits and the
// kind of image its bytes are; the kind is read from the bytes, never from a file name or a declared
// type, so only PNG, JPEG and WebP ever come back out (no SVG, no HTML: nothing a browser would run).

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

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

const joined = (parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

/**
 * The picture without what is not the picture: a phone photo carries where it was taken, and an upload
 * here is public. JPEG loses its APP1 (EXIF, XMP), APP13 (IPTC) and comment segments; PNG its text and
 * eXIf chunks; WebP its EXIF and XMP chunks, with the size and the flags that announced them fixed. A
 * file whose structure does not hold gives null, to be refused rather than stored with what it hides.
 */
export function stripMetadata(b: Uint8Array, kind: ImageKind): Uint8Array | null {
  if (kind === "jpg") {
    const out: Uint8Array[] = [b.subarray(0, 2)];
    let i = 2;
    for (;;) {
      if (i + 2 > b.length || b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xff) {
        i += 1; // a fill byte before a marker
        continue;
      }
      if (marker === 0xda || marker === 0xd9) return joined([...out, b.subarray(i)]); // the image data, as it is
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        out.push(b.subarray(i, i + 2));
        i += 2;
        continue;
      }
      if (i + 4 > b.length) return null;
      const end = i + 2 + ((b[i + 2]! << 8) | b[i + 3]!);
      if (end < i + 4 || end > b.length) return null;
      if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) out.push(b.subarray(i, end));
      i = end;
    }
  }
  const view = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (kind === "png") {
    const out: Uint8Array[] = [b.subarray(0, 8)];
    let i = 8;
    while (i < b.length) {
      if (i + 12 > b.length) return null;
      const type = view.toString("latin1", i + 4, i + 8);
      const end = i + 12 + view.readUInt32BE(i);
      if (end > b.length) return null;
      if (!["tEXt", "zTXt", "iTXt", "eXIf"].includes(type)) out.push(b.subarray(i, end));
      i = end;
      if (type === "IEND") break;
    }
    return joined(out);
  }
  const out: Uint8Array[] = [];
  let i = 12;
  while (i < b.length) {
    if (i + 8 > b.length) return null;
    const type = view.toString("latin1", i, i + 4);
    const size = view.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2);
    if (end > b.length) return null;
    if (type !== "EXIF" && type !== "XMP ") out.push(b.subarray(i, end));
    i = end;
  }
  const body = Buffer.concat([Buffer.from("WEBP"), ...out]);
  const file = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
  file.writeUInt32LE(body.length, 4);
  if (file.toString("latin1", 12, 16) === "VP8X") file[20] = file[20]! & ~0x0c; // the EXIF and XMP flags
  return new Uint8Array(file);
}

/** The folder: UPLOADS_DIR, else `uploads` beside the database file. */
export function uploadsDir(): string {
  return process.env.UPLOADS_DIR ?? path.join(path.dirname(databasePath()), "uploads");
}

/** Write the bytes under a new random name and return the name. The caller has checked kind and size. */
export function storeUpload(bytes: Uint8Array, kind: ImageKind): string {
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${randomBytes(16).toString("base64url")}.${kind}`;
  fs.writeFileSync(path.join(dir, name), bytes, { flag: "wx" });
  return name;
}

/** Delete a stored file by its name or its /uploads/ address; anything else is left alone. */
export function discardUpload(nameOrPath: string | null | undefined): void {
  if (!nameOrPath) return;
  const name = nameOrPath.startsWith("/uploads/") ? nameOrPath.slice("/uploads/".length) : nameOrPath;
  if (!UPLOAD_NAME.test(name)) return;
  fs.rmSync(path.join(uploadsDir(), name), { force: true });
}

/** A stored file and the type its name says, or null for a malformed name or a missing file. */
export function readUpload(name: string): { bytes: Buffer; type: string } | null {
  if (!UPLOAD_NAME.test(name)) return null;
  try {
    return { bytes: fs.readFileSync(path.join(uploadsDir(), name)), type: TYPE[name.split(".").pop() as ImageKind] };
  } catch {
    return null;
  }
}
