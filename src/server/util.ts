import "server-only";
import crypto from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/o, 1/l

/** A prefixed random id for rows created in the app, e.g. prj_k3x9w2m8q4ab. */
export function newId(prefix: string, length = 12): string {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** An id in newId's shape worked out from a key: the same key always gives the same id. */
export function derivedId(prefix: string, key: string, length = 12): string {
  const bytes = crypto.createHash("sha256").update(key).digest();
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** A random URL-safe secret for cookies and invite links (letters and digits only). */
export function newSecret(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url").replace(/[-_]/g, "x");
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** JSON with object keys sorted at every depth, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "event"
  );
}
