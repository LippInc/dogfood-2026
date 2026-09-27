"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { SignatureBits } from "@/components/signature-bits";

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
  // A key download that fails says nothing about the record: say the check could not run here.
  if (!res.ok) return { at: "unsupported", why: `The public keys could not be loaded (${res.status}), so your browser could not check it.` };
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
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = fromBase64url(String(envelope.signature));
  } catch {
    return { at: "invalid", why: "The signature is not in the expected form (base64url)." };
  }
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    publicKey,
    signature,
    new TextEncoder().encode(canonical(envelope.record)),
  );
  return ok ? { at: "valid", kid: key.kid } : { at: "invalid", why: "The signature does not match this record." };
}

const CheckState = createContext<State>({ at: "checking" });

/**
 * Runs the in-browser check once for the whole record page and hands its state to
 * everything under it: the seal on the certificate and the status box below it.
 */
export function RecordCheck({ envelope, children }: { envelope: Envelope; children: React.ReactNode }) {
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
  return <CheckState.Provider value={state}>{children}</CheckState.Provider>;
}

/**
 * The certificate sheet itself. Once this browser has checked the signature, the sheet
 * is "lit": its corner marks, the project's face and the place figure take the accent,
 * with the seal. Until then, or when the check fails, they stay grey.
 */
export function CheckedSheet({ className, children, ...rest }: React.ComponentProps<"article">) {
  const state = useContext(CheckState);
  return (
    <article {...rest} data-check={state.at} className={`${className ?? ""} ${state.at === "valid" ? "lit" : ""}`}>
      {children}
    </article>
  );
}

/**
 * The certificate's seal: the signature itself, one square per bit. It lights up in
 * the accent once this browser has checked the signature, and its frame turns to the
 * alarm colour if the check fails, so the seal shows what the browser found.
 */
export function LiveSeal({ signature }: { signature: string }) {
  const state = useContext(CheckState);
  return (
    <figure className="flex flex-col gap-2" data-check={state.at}>
      <div
        className={`overflow-hidden rounded-xs border transition-colors duration-500 motion-reduce:transition-none ${
          state.at === "invalid" ? "border-flag-bar" : state.at === "valid" ? "border-accent" : "border-rule"
        }`}
      >
        <SignatureBits signature={signature} lit={state.at === "valid"} />
      </div>
      <figcaption className="flex flex-col gap-0.5">
        <span className="label-mono text-ink-3">Signature · every bit</span>
        <span className="flex min-h-5 items-center gap-1.5 text-13">
          {state.at === "checking" ? (
            <span className="text-ink-2">Checking in your browser…</span>
          ) : state.at === "valid" ? (
            <span className="stamp inline-flex items-start gap-1.5">
              <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-hidden />
              <span>
                <strong className="font-semibold text-ok">Valid</strong>
                <span className="text-ink-2">, checked by your browser</span>
              </span>
            </span>
          ) : state.at === "invalid" ? (
            <span className="stamp inline-flex items-center gap-1.5 font-semibold text-flag">
              <X className="size-4" aria-hidden /> Not valid
            </span>
          ) : (
            <span className="text-ink-2">Your browser could not check it</span>
          )}
        </span>
      </figcaption>
    </figure>
  );
}

export function BrowserCheck({ serverSays }: { serverSays: boolean }) {
  const state = useContext(CheckState);
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

/** One letter of a name moved on by one (a to b, z to a), so the forged copy differs by exactly one character. */
function forgeName(name: string): { forged: string; at: number } {
  for (let i = name.length - 1; i >= 0; i--) {
    const c = name[i];
    if (/[a-y]/i.test(c)) return { forged: name.slice(0, i) + String.fromCharCode(c.charCodeAt(0) + 1) + name.slice(i + 1), at: i };
    if (c === "z" || c === "Z") return { forged: name.slice(0, i) + (c === "z" ? "a" : "A") + name.slice(i + 1), at: i };
  }
  return { forged: `${name}.`, at: name.length };
}

/**
 * "Try to forge it": change one letter of the name in a copy of the record and run
 * the very same check on the copy, in this browser. The copy never leaves the page.
 */
export function ForgeTry({ envelope }: { envelope: Envelope }) {
  const person = (envelope.record.person as { name?: string } | undefined)?.name ?? "";
  const { forged, at } = forgeName(person);
  const [result, setResult] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  if (!person) return null;
  const run = async () => {
    setBusy(true);
    const copy = structuredClone(envelope);
    (copy.record.person as { name: string }).name = forged;
    try {
      setResult(await checkInBrowser(copy));
    } catch {
      setResult({ at: "unsupported", why: "The check could not run in this browser." });
    } finally {
      setBusy(false);
    }
  };
  const shown = result ? forged : person;
  const button = "inline-flex h-10 items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-raised disabled:opacity-60";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <span className="font-serif text-24" aria-label={`The name in the ${result ? "changed copy" : "record"}: ${shown}`}>
          {shown.slice(0, at)}
          <mark className={`rounded-xs px-0.5 ${result ? "bg-accent text-on-accent" : "bg-accent-tint text-ink"}`}>{shown[at] ?? ""}</mark>
          {shown.slice(at + 1)}
        </span>
        {result ? (
          <button type="button" onClick={() => setResult(null)} className={button}>
            Put the letter back
          </button>
        ) : (
          <button type="button" onClick={run} disabled={busy} className={button}>
            {busy ? "Checking the copy…" : `Change “${person[at] ?? ""}” to “${forged[at]}” and check`}
          </button>
        )}
      </div>
      <div aria-live="polite">
        {result ? (
          result.at === "invalid" ? (
            <p className="stamp rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">
              <strong className="font-semibold text-flag">Not valid.</strong> {result.why} One changed letter is enough: the signature covers every byte of
              the record.
            </p>
          ) : result.at === "valid" ? (
            <p className="rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">
              The changed copy checked as valid, which must never happen: please tell the portal&rsquo;s operator.
            </p>
          ) : (
            <p className="rounded-sm border border-rule px-4 py-3 text-15 text-ink-2">{result.at === "unsupported" ? result.why : "Checking the copy."}</p>
          )
        ) : null}
      </div>
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
