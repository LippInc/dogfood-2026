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

/** Letters with no Latin base that NFKD cannot take apart: Cyrillic, Greek and a few Latin ones, spelt out. */
const SPELT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", ё: "e", є: "ye", ж: "zh", з: "z", и: "i", і: "i", ї: "yi", й: "y",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch",
  ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", ў: "u", ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c", џ: "dz",
  α: "a", β: "v", γ: "g", δ: "d", ε: "e", ζ: "z", η: "i", θ: "th", ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o",
  π: "p", ρ: "r", σ: "s", ς: "s", τ: "t", υ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o",
  ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i", ŋ: "ng",
};

/**
 * A web address part from a name: lower-case letters, digits and single hyphens, at most 60 characters, never a
 * hyphen at either end. Accents are dropped and Cyrillic and Greek are spelt out in Latin letters; a name with
 * nothing left (Chinese, Arabic, only symbols) gets the fallback and a short suffix from the name itself, so two
 * such names do not collide and the same name always gives the same address.
 */
export function slugify(text: string, fallback = "event"): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/./gu, (c) => SPELT[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || `${fallback}-${sha256(text).slice(0, 6)}`;
}
