"use client";

import { useEffect, useState } from "react";

type Envelope = { record: Record<string, unknown>; signature: string };
type Key = { kid: string; kty: string; crv: string; x: string };

type State =
  | { at: "checking" }
  | { at: "valid"; kid: string }
  | { at: "invalid"; why: string }
  | { at: "unsupported"; why: string };

/** Keys sorted at every depth, arrays in order, no whitespace: the exact bytes the portal signed. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value));
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Verify an envelope in this browser with WebCrypto, against the keys the portal publishes. */
export async function checkInBrowser(envelope: Envelope, keysUrl = "/.well-known/dogfood-keys.json"): Promise<State> {
  if (!globalThis.crypto?.subtle) return { at: "unsupported", why: "This browser has no WebCrypto." };
  const res = await fetch(keysUrl, { cache: "no-store" });
  if (!res.ok) return { at: "invalid", why: `Could not load the public keys (${res.status}).` };
  const { keys } = (await res.json()) as { keys: Key[] };
  const kid = envelope.record.keyId;
  const key = keys.find((k) => k.kid === kid);
  if (!key) return { at: "invalid", why: `No published key has the id ${String(kid)}.` };
  let publicKey: CryptoKey;
  try {
    publicKey = await crypto.subtle.importKey("jwk", { kty: key.kty, crv: key.crv, x: key.x }, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { at: "unsupported", why: "This browser cannot check Ed25519 signatures yet." };
  }
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    fromBase64url(envelope.signature),
    new TextEncoder().encode(canonical(envelope.record)),
  );
  return ok ? { at: "valid", kid: key.kid } : { at: "invalid", why: "The signature does not match this record." };
}

export function BrowserCheck({ envelope, serverSays }: { envelope: Envelope; serverSays: boolean }) {
  const [state, setState] = useState<State>({ at: "checking" });
  useEffect(() => {
    let live = true;
    checkInBrowser(envelope)
      .then((s) => live && setState(s))
      .catch(() => live && setState({ at: "unsupported", why: "The check could not run in this browser." }));
    return () => {
      live = false;
    };
  }, [envelope]);

  const tone =
    state.at === "valid"
      ? "border-ok text-ink"
      : state.at === "invalid"
        ? "border-flag-bar bg-flag-bg text-ink"
        : "border-rule text-ink-2";
  return (
    <div role="status" aria-live="polite" className={`rounded-sm border-l-4 border-y border-r px-4 py-3 text-15 ${tone}`}>
      {state.at === "checking" ? (
        <>Checking the signature in your browser…</>
      ) : state.at === "valid" ? (
        <>
          <strong className="font-semibold text-ok">Signature valid.</strong> Your browser checked it with WebCrypto against key{" "}
          <code className="font-mono text-13">{state.kid}</code>, fetched from{" "}
          <a href="/.well-known/dogfood-keys.json" className="underline underline-offset-4">
            /.well-known/dogfood-keys.json
          </a>
          .
        </>
      ) : state.at === "invalid" ? (
        <>
          <strong className="font-semibold text-flag">Not valid.</strong> {state.why}
        </>
      ) : (
        <>
          {state.why} The portal&rsquo;s own check says the signature is {serverSays ? "valid" : "not valid"}; the steps below let you check it
          elsewhere.
        </>
      )}
    </div>
  );
}

export function RecordActions({ envelope, id }: { envelope: Envelope; id: string }) {
  const [copied, setCopied] = useState(false);
  const download = () => {
    const blob = new Blob([JSON.stringify(envelope, null, 2) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const button = "inline-flex h-10 items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-raised";
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => window.print()} className={button}>
        Print
      </button>
      <button type="button" onClick={download} className={button}>
        Download the record (.json)
      </button>
      <button
        type="button"
        className={button}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(window.location.href);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            window.prompt("Copy this link:", window.location.href);
          }
        }}
      >
        <span aria-live="polite">{copied ? "Link copied" : "Copy the link"}</span>
      </button>
    </div>
  );
}
