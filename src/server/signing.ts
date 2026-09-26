import "server-only";
import crypto from "node:crypto";
import { desc } from "drizzle-orm";
import { appendAudit } from "./audit";
import type { DbOrTx } from "./db/client";
import { signingKeys, type PublicJwk, type SignedEnvelope } from "./db/schema";
import { canonicalJson, newId, nowIso } from "./util";

// Signed records: the portal holds one Ed25519 key, made at first boot and kept in
// the database on the data volume. A record is signed over its canonical JSON (keys
// sorted at every depth, no whitespace), so anyone holding the record and the public
// key can check it without asking the portal: in a browser with WebCrypto, with
// scripts/verify-record.mjs, or with any Ed25519 library.

export type KeyRow = typeof signingKeys.$inferSelect;

/** The published form of a key, as served at /.well-known/dogfood-keys.json. */
export type PublishedKey = PublicJwk & { kid: string; alg: "EdDSA"; use: "sig"; createdAt: string };

/** The signing key; the first call makes it and records its public half in the audit log. */
export function ensureSigningKey(db: DbOrTx, now = nowIso()): KeyRow {
  const existing = db.select().from(signingKeys).orderBy(desc(signingKeys.createdAt)).get();
  if (existing) return existing;
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const { x } = publicKey.export({ format: "jwk" }) as { x: string };
  const row: KeyRow = {
    id: newId("key", 10),
    publicJwk: { kty: "OKP", crv: "Ed25519", x },
    privatePkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: now,
  };
  db.transaction((tx) => {
    tx.insert(signingKeys).values(row).run();
    appendAudit(
      tx,
      { actorUserId: null, actorLabel: "System", action: "signing_key.create", targetType: "signing_key", targetId: row.id, after: { kid: row.id, x } },
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
  const privateKey = crypto.createPrivateKey({ key: Buffer.from(key.privatePkcs8, "base64"), format: "der", type: "pkcs8" });
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
