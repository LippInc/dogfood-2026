import { afterEach, describe, expect, it, vi } from "vitest";
import { checkInBrowser } from "@/app/records/[record]/check";

const record = { id: "rec_test", keyId: "key_test" };
const b64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [{ kid: "key_test", kty: jwk.kty, crv: jwk.crv, x: jwk.x }] })));
  return pair;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the in-browser signature check", () => {
  it("positive control: a real signature over the canonical record is valid", async () => {
    const pair = await keyPair();
    const bytes = new TextEncoder().encode(JSON.stringify({ id: record.id, keyId: record.keyId }));
    const signature = b64url(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, bytes));
    expect(await checkInBrowser({ record, signature })).toEqual({ at: "valid", kid: "key_test" });
  });

  it("known-bad: a failed download of the public keys is 'could not check here', never 'not valid'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    expect((await checkInBrowser({ record, signature: "AAAA" })).at).toBe("unsupported");
  });

  it("known-bad: a signature that is not base64url is 'not valid', not a crash", async () => {
    await keyPair();
    for (const signature of ["A", "not base64!"]) {
      expect((await checkInBrowser({ record, signature })).at).toBe("invalid");
    }
  });
});
