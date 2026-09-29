// verify-record.mjs — a standalone verifier for this portal's signed records.
//
// What it checks: that a record's Ed25519 signature (base64url) matches the record's
// canonical JSON — object keys sorted at every depth, arrays in order, JSON.stringify
// with no whitespace — computed exactly as the portal computes it (src/lib/canonical-json.ts,
// which says the one detail: keys that are array indices, such as "2" and "10", come
// first, by number; a record has none). Only Node built-ins; no portal, no database,
// no npm packages. tests/canonical-json.test.ts holds this copy to the portal's.
//
// Usage: node scripts/verify-record.mjs <record> [--keys <keys>] [--canonical]
//   <record>  a path to a JSON file holding the envelope { record, signature }
//             itself (or { envelope, ... } as GET /api/records/<id> serves), or
//             an http(s):// URL of /api/records/<id> or of the page /records/<id>.
//   --keys    a path or http(s):// URL of a saved keys document
//             ({ issuer, format, keys: [...] } as /.well-known/dogfood-keys.json
//             serves).
//   --canonical  print the record's canonical JSON, the exact bytes the signature
//             covers, and stop (no key is needed): to check them with other tools.
//
// Trust: without --keys the keys are fetched from
// <record.issuer>/.well-known/dogfood-keys.json — the issuer named inside the
// record itself — so the check proves only that that issuer signed it. Pin a
// saved keys file with --keys for a check that does not trust the network.
//
// Exit codes: 0 valid, 1 invalid, 2 usage error or an unreadable file/URL.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const USAGE = "usage: node scripts/verify-record.mjs <record> [--keys <keys>] [--canonical]";

const args = process.argv.slice(2);
const keysAt = args.indexOf("--keys");
const keysRef = keysAt >= 0 ? args[keysAt + 1] : undefined;
const printCanonical = args.includes("--canonical");
const recordRef = args.filter((a, i) => a !== "--keys" && a !== "--canonical" && args[i - 1] !== "--keys")[0];
if (!recordRef || (keysAt >= 0 && !keysRef)) {
  console.error(USAGE);
  process.exit(2);
}

const isUrl = (ref) => /^https?:\/\//i.test(ref);

/** Canonical JSON: keys sorted at every depth, arrays in order, no whitespace; written as the portal writes it. */
function canonical(value) {
  const sortKeys = (v) =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
        : v;
  return JSON.stringify(sortKeys(value));
}

function die(message) {
  console.error(message);
  process.exit(2);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function loadJson(ref, what) {
  try {
    return isUrl(ref) ? await getJson(ref) : JSON.parse(readFileSync(ref, "utf8"));
  } catch (cause) {
    die(`cannot read ${what} "${ref}": ${cause.message}`);
  }
}

/** A /records/<id> page URL names the same record as /api/records/<id> on that origin. */
function apiUrlOf(ref) {
  const url = new URL(ref);
  if (url.pathname.startsWith("/records/")) url.pathname = `/api/records/${url.pathname.slice("/records/".length)}`;
  return url.href;
}

async function main() {
  const fetched = await loadJson(isUrl(recordRef) ? apiUrlOf(recordRef) : recordRef, "record");
  const envelope =
    fetched && typeof fetched === "object" && "record" in fetched && "signature" in fetched ? fetched : fetched?.envelope;
  const e = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope : null;
  const record = e && e.record && typeof e.record === "object" && !Array.isArray(e.record) ? e.record : null;
  const signature = e && typeof e.signature === "string" ? e.signature : null;
  if (printCanonical) {
    if (!record) die(`no record in "${recordRef}"`);
    process.stdout.write(canonical(record));
    return;
  }

  const field = (obj, k) => (obj && typeof obj[k] === "string" ? obj[k] : "?");
  console.log(`format:    ${field(record, "format")}`);
  console.log(`kind:      ${field(record, "kind")}`);
  console.log(`id:        ${field(record, "id")}`);
  console.log(`person:    ${field(record?.person, "name")}`);
  console.log(`event:     ${field(record?.event, "name")}`);
  console.log(`issuer:    ${field(record, "issuer")}`);
  console.log(`key id:    ${field(record, "keyId")}`);

  const invalid = (reason) => {
    console.log(`INVALID: ${reason}`);
    process.exit(1);
  };
  if (!record || !signature || typeof record.issuer !== "string" || typeof record.keyId !== "string")
    invalid("malformed envelope");

  let keysDoc;
  if (keysRef) {
    keysDoc = await loadJson(keysRef, "keys");
    console.log(`keys:      pinned (${keysRef}); this check does not trust the network`);
  } else {
    const url = `${record.issuer.replace(/\/+$/, "")}/.well-known/dogfood-keys.json`;
    keysDoc = await loadJson(url, "keys");
    console.log(
      `keys:      fetched from ${url}, the issuer named inside the record — this proves only that that issuer signed it; pin a saved keys file with --keys for a check that does not trust the network`,
    );
  }
  if (!keysDoc || !Array.isArray(keysDoc.keys)) die(`the keys document has no "keys" array`);

  const key = keysDoc.keys.find((k) => k && typeof k === "object" && k.kid === record.keyId);
  if (!key) invalid(`unknown key id ${JSON.stringify(record.keyId)}`);
  if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.x !== "string") invalid("wrong key type");

  let ok = false;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x }, format: "jwk" });
    ok = crypto.verify(null, Buffer.from(canonical(record), "utf8"), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    ok = false;
  }
  console.log(ok ? "VALID" : "INVALID: signature does not match");
  process.exit(ok ? 0 : 1);
}

main().catch((cause) => die(`unexpected error: ${cause.message}`));
