import crypto from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { auditLog, signingKeys } from "@/server/db/schema";
import { ensureSigningKey, publishedKeys, signRecord, verifyEnvelope } from "@/server/signing";

// The signing key's private half is sealed under DOGFOOD_SEED_SECRET: a copy of the
// database alone cannot sign. A key from before sealing is sealed at the next start; a
// key sealed under another secret is replaced, and what it signed keeps verifying.

const NOW = "2026-09-27T12:00:00.000Z";
let h: Handle;
let oldSecret: string | undefined;

beforeEach(() => {
  oldSecret = process.env.DOGFOOD_SEED_SECRET;
  process.env.DOGFOOD_SEED_SECRET = "secret-one";
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
});

afterEach(() => {
  h.sqlite.close();
  if (oldSecret === undefined) delete process.env.DOGFOOD_SEED_SECRET;
  else process.env.DOGFOOD_SEED_SECRET = oldSecret;
});

const stored = () => h.db.select().from(signingKeys).all();
const actions = () => h.db.select({ action: auditLog.action, after: auditLog.after }).from(auditLog).all();
const record = (keyId: string, n: number) => ({ format: "test", keyId, n });

describe("the sealed signing key", () => {
  it("is not usable from the database alone, and signs with the secret (known-bad: the plain PKCS8 of old)", () => {
    const key = ensureSigningKey(h.db, NOW);
    const [row] = stored();
    expect(row!.privatePkcs8.startsWith("sealed-v1:")).toBe(true);
    expect(() => crypto.createPrivateKey({ key: Buffer.from(row!.privatePkcs8, "base64"), format: "der", type: "pkcs8" })).toThrow();
    const envelope = signRecord(key, record(key.id, 1));
    expect(verifyEnvelope(envelope, publishedKeys(h.db))).toEqual({ valid: true, keyId: key.id });
    expect(ensureSigningKey(h.db, NOW).id).toBe(key.id); // the same key on the next call
  });

  it("seals a key made before sealing in place, audited, and it signs as the same key", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const { x } = publicKey.export({ format: "jwk" }) as { x: string };
    h.db.insert(signingKeys).values({
      id: "key_legacy01",
      publicJwk: { kty: "OKP", crv: "Ed25519", x },
      privatePkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      createdAt: NOW,
    }).run();

    const key = ensureSigningKey(h.db, NOW);
    expect(key.id).toBe("key_legacy01");
    expect(stored()[0]!.privatePkcs8.startsWith("sealed-v1:")).toBe(true);
    expect(actions().filter((a) => a.action === "signing_key.seal")).toHaveLength(1);
    expect(verifyEnvelope(signRecord(key, record(key.id, 2)), publishedKeys(h.db))).toEqual({ valid: true, keyId: "key_legacy01" });
  });

  it("under another secret makes a new key, naming the one it replaces; records signed before still verify", () => {
    const first = ensureSigningKey(h.db, NOW);
    const before = signRecord(first, record(first.id, 3));

    process.env.DOGFOOD_SEED_SECRET = "secret-two";
    expect(() => signRecord(first, record(first.id, 4))).toThrow(/sealed under another/);
    const second = ensureSigningKey(h.db, "2026-09-27T12:00:01.000Z");
    expect(second.id).not.toBe(first.id);
    expect(actions().filter((a) => a.action === "signing_key.create").at(-1)!.after).toMatchObject({ kid: second.id, replaces: first.id });

    const keys = publishedKeys(h.db);
    expect(keys.map((k) => k.kid).sort()).toEqual([first.id, second.id].sort());
    expect(verifyEnvelope(before, keys)).toEqual({ valid: true, keyId: first.id });
    expect(verifyEnvelope(signRecord(second, record(second.id, 5)), keys)).toEqual({ valid: true, keyId: second.id });
  });
});
