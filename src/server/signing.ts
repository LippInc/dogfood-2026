import "server-only";
import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { appendAudit } from "./audit";
import { DEFAULT_SEED_SECRET } from "./checker";
import type { DbOrTx } from "./db/client";
import { signingKeys, type PublicJwk, type SignedEnvelope } from "./db/schema";
import { canonicalJson, newId, nowIso } from "./util";

// Signed records: the portal holds one Ed25519 key, made at first boot and kept in
// the database on the data volume. A record is signed over its canonical JSON (keys
// sorted at every depth, no whitespace), so anyone holding the record and the public
// key can check it without asking the portal: in a browser with WebCrypto, with
// scripts/verify-record.mjs, or with any Ed25519 library.
//
// The private half never sits in the database in the clear: it is sealed with
// AES-256-GCM under a key derived from DOGFOOD_SEED_SECRET and the key's id, so a copy
// of the database (a backup, a stolen volume) cannot sign without the secret. A key
// sealed under another secret cannot be opened; the portal then makes a new key, and
// records signed before keep verifying against the old public key, still published.

export type KeyRow = typeof signingKeys.$inferSelect;

/** The published form of a key, as served at /.well-known/dogfood-keys.json. */
export type PublishedKey = PublicJwk & { kid: string; alg: "EdDSA"; use: "sig"; createdAt: string };

const SEALED = "sealed-v1:";

function sealingKey(keyId: string): Buffer {
  const secret = process.env.DOGFOOD_SEED_SECRET || DEFAULT_SEED_SECRET;
  return Buffer.from(crypto.hkdfSync("sha256", secret, "dogfood-signing-key", keyId, 32));
}

function seal(keyId: string, pkcs8: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealingKey(keyId), iv).setAAD(Buffer.from(keyId));
  const body = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  return SEALED + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

/** The key's private half, or null when it is sealed under another secret. */
function unseal(key: KeyRow): crypto.KeyObject | null {
  if (!key.privatePkcs8.startsWith(SEALED)) {
    return crypto.createPrivateKey({ key: Buffer.from(key.privatePkcs8, "base64"), format: "der", type: "pkcs8" });
  }
  const raw = Buffer.from(key.privatePkcs8.slice(SEALED.length), "base64");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", sealingKey(key.id), raw.subarray(0, 12)).setAAD(Buffer.from(key.id));
    decipher.setAuthTag(raw.subarray(12, 28));
    const pkcs8 = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  } catch {
    return null;
  }
}

/**
 * The signing key. The first call makes it and records its public half in the audit
 * log; a key from before sealing is sealed in place; a newest key sealed under another
 * secret is replaced by a new one (audited, naming the one it replaces).
 */
export function ensureSigningKey(db: DbOrTx, now = nowIso()): KeyRow {
  const existing = db.select().from(signingKeys).orderBy(desc(signingKeys.createdAt)).get();
  if (existing && !existing.privatePkcs8.startsWith(SEALED)) {
    const sealed: KeyRow = { ...existing, privatePkcs8: seal(existing.id, Buffer.from(existing.privatePkcs8, "base64")) };
    db.transaction((tx) => {
      tx.update(signingKeys).set({ privatePkcs8: sealed.privatePkcs8 }).where(eq(signingKeys.id, existing.id)).run();
      appendAudit(
        tx,
        { actorUserId: null, actorLabel: "System", action: "signing_key.seal", targetType: "signing_key", targetId: existing.id, after: { kid: existing.id } },
        now,
      );
    });
    return sealed;
  }
  if (existing && unseal(existing)) return existing;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" }) as { x: string };
  const id = newId("key", 10);
  const row: KeyRow = {
    id,
    publicJwk: { kty: "OKP", crv: "Ed25519", x },
    privatePkcs8: seal(id, privateKey.export({ format: "der", type: "pkcs8" })),
    createdAt: now,
  };
  db.transaction((tx) => {
    tx.insert(signingKeys).values(row).run();
    appendAudit(
      tx,
      {
        actorUserId: null,
        actorLabel: "System",
        action: "signing_key.create",
        targetType: "signing_key",
        targetId: row.id,
        after: { kid: row.id, x, ...(existing ? { replaces: existing.id } : {}) },
      },
      now,
    );
  });
  return row;
}

export function publishedKeys(db: DbOrTx): PublishedKey[] {
  return db
    .select({ id: signingKeys.id, publicJwk: signingKeys.publicJwk, createdAt: signingKeys.createdAt })
    .from(signingKeys)
    .orderBy(signingKeys.createdAt)
    .all()
    .map((k) => ({ kid: k.id, ...k.publicJwk, alg: "EdDSA", use: "sig", createdAt: k.createdAt }));
}

export function signRecord(key: KeyRow, record: Record<string, unknown>): SignedEnvelope {
  const privateKey = unseal(key);
  if (!privateKey) throw new Error(`The signing key ${key.id} is sealed under another DOGFOOD_SEED_SECRET.`);
  const signature = crypto.sign(null, Buffer.from(canonicalJson(record), "utf8"), privateKey).toString("base64url");
  return { record, signature };
}

export type Verification =
  | { valid: true; keyId: string }
  | { valid: false; reason: "malformed" | "unknown_key" | "bad_signature"; message: string };

/**
 * Check an envelope against published keys. Pure: the keys are passed in, so the
 * same function checks a record against this portal's keys or anyone else's.
 */
export function verifyEnvelope(envelope: unknown, keys: Pick<PublishedKey, "kid" | "x">[]): Verification {
  const e = envelope as Partial<SignedEnvelope> | null;
  const record = e && typeof e === "object" ? e.record : undefined;
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof e?.signature !== "string") {
    return { valid: false, reason: "malformed", message: "Expected { record: {...}, signature: \"...\" }." };
  }
  const keyId = (record as Record<string, unknown>).keyId;
  const key = keys.find((k) => k.kid === keyId);
  if (!key) return { valid: false, reason: "unknown_key", message: `No published key has the id ${JSON.stringify(keyId)}.` };
  let ok = false;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" });
    ok = crypto.verify(null, Buffer.from(canonicalJson(record), "utf8"), publicKey, Buffer.from(e!.signature!, "base64url"));
  } catch {
    ok = false;
  }
  return ok
    ? { valid: true, keyId: key.kid }
    : { valid: false, reason: "bad_signature", message: "The signature does not match this record: it was changed after signing, or signed by another key." };
}
