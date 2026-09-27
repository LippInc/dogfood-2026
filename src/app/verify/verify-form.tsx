"use client";

import { useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SignatureBits } from "@/components/signature-bits";
import { checkInBrowser } from "../records/[record]/check";

type Envelope = { record: Record<string, unknown>; signature: string };
type Outcome = {
  browser: Awaited<ReturnType<typeof checkInBrowser>>;
  portal: { valid: boolean; reason?: string; message?: string };
  record: Record<string, unknown>;
  signature: string;
};

function envelopeOf(text: string): Envelope | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const e = parsed && typeof parsed === "object" && "envelope" in parsed ? (parsed as { envelope: unknown }).envelope : parsed;
    if (e && typeof e === "object" && "record" in e && "signature" in e) return e as Envelope;
  } catch {}
  return null;
}

type Mark = "ok" | "bad" | "idle";
function StepMark({ mark }: { mark: Mark }) {
  if (mark === "ok") return <Check className="size-4 text-ok" aria-label="passed" />;
  if (mark === "bad") return <X className="size-4 text-flag" aria-label="failed" />;
  return <Minus className="size-4 text-ink-3" aria-hidden />;
}

export function VerifyForm() {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  async function check() {
    setOutcome(null);
    const envelope = envelopeOf(text);
    if (!envelope) {
      setProblem("That is not a signed record: expected JSON with a \"record\" and a \"signature\".");
      return;
    }
    setProblem(null);
    setBusy(true);
    try {
      const [browser, portal] = await Promise.all([
        // A browser that cannot run its check must not throw away the portal's answer.
        checkInBrowser(envelope).catch(() => ({ at: "unsupported" as const, why: "Your browser could not run its own check." })),
        fetch("/api/records/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }).then((r) => r.json()),
      ]);
      setOutcome({ browser, portal, record: envelope.record, signature: String(envelope.signature) });
    } catch {
      setProblem("The check could not run. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const person = (outcome?.record.person as { name?: string } | undefined)?.name;
  const event = (outcome?.record.event as { name?: string } | undefined)?.name;
  const id = typeof outcome?.record.id === "string" ? outcome.record.id : null;
  const valid = outcome?.portal.valid && outcome.browser.at !== "invalid";
  const kind = outcome?.record.kind === "judge" ? "judging record" : "certificate";
  const parsed = text.trim() ? envelopeOf(text) !== null : null;
  const browserMark: Mark = !outcome ? "idle" : outcome.browser.at === "valid" ? "ok" : outcome.browser.at === "invalid" ? "bad" : "idle";
  const portalMark: Mark = !outcome ? "idle" : outcome.portal.valid ? "ok" : "bad";

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-14">
      <div className="flex min-w-0 flex-col gap-4">
        <label htmlFor="record-text" className="text-14 font-medium">
          The record (JSON)
        </label>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={async (e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) {
              setOutcome(null);
              setText(await file.text());
            }
          }}
          className={`relative rounded-sm ${dragging ? "outline-2 outline-offset-2 outline-accent outline-dashed" : ""}`}
        >
          <Textarea
            id="record-text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setOutcome(null);
            }}
            rows={10}
            spellCheck={false}
            aria-describedby="record-help"
            className="font-mono text-12"
            placeholder='{ "record": { ... }, "signature": "..." }'
          />
        </div>
        <p id="record-help" className="text-13 text-ink-3">
          Paste it, open the file, or drop the file on the box.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" onClick={check} disabled={busy || !text.trim()}>
            {busy ? "Checking…" : "Check the signature"}
          </Button>
          <label className="inline-flex h-10 cursor-pointer items-center rounded-sm border border-edge px-4 text-14 font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus hover:bg-raised">
            Open a file
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setOutcome(null);
                  setText(await file.text());
                }
              }}
            />
          </label>
        </div>
        <div role="status" aria-live="polite">
          {problem ? <p className="rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">{problem}</p> : null}
          {outcome ? (
            valid ? (
              <article aria-label="Result" className="corner-marks stamp mt-2 flex flex-col gap-5 rounded-sm border border-accent p-6 sm:p-8">
                <p className="label-mono flex items-center gap-2 text-ok">
                  <Check className="size-4" aria-hidden /> Valid
                </p>
                <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_176px] sm:items-end">
                  <div className="min-w-0 wrap-anywhere">
                    <p className="text-13 font-medium uppercase tracking-[0.14em] text-ink-2">A {kind} for</p>
                    <p className="mt-1 font-serif text-38 leading-[1.1]">{person ?? "someone"}</p>
                    <p className="mt-2 font-serif text-17 text-ink-2">
                      {event ?? "an event"}, signed by this portal and unchanged since.
                    </p>
                  </div>
                  <div className="overflow-hidden rounded-xs border border-accent">
                    <SignatureBits signature={outcome.signature} lit />
                  </div>
                </div>
                {id ? (
                  <a href={`/records/${encodeURIComponent(id)}`} className="self-start text-15 font-medium underline decoration-edge underline-offset-4 hover:decoration-ink">
                    Open the record&rsquo;s page
                  </a>
                ) : null}
              </article>
            ) : (
              <div className="stamp mt-2 rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">
                <p>
                  <strong className="font-semibold text-flag">Not valid.</strong> {outcome.portal.message ?? "The signature does not match this record."}
                </p>
                <p className="mt-2 text-14 text-ink-2">
                  Something in it changed after it was signed, or this portal never signed it. Every byte counts: one changed letter is enough.
                </p>
              </div>
            )
          ) : null}
        </div>
      </div>

      <aside aria-labelledby="how-title" className="self-start border-t-2 border-ink pt-3">
        <h2 id="how-title" className="label-mono text-ink">
          Fig. 01 — What the check does
        </h2>
        <ol className="mt-4 flex flex-col divide-y divide-rule border-b border-rule">
          <li className="flex gap-3 py-3">
            <span className="font-mono text-12 leading-5 text-ink-3">01</span>
            <span className="min-w-0 flex-1 text-14">
              <span className="font-medium">Read the record.</span>{" "}
              <span className="text-ink-2">Its keys are sorted at every depth and the spaces dropped: those exact bytes were signed.</span>
            </span>
            <StepMark mark={parsed === null ? "idle" : parsed ? "ok" : "bad"} />
          </li>
          <li className="flex gap-3 py-3">
            <span className="font-mono text-12 leading-5 text-ink-3">02</span>
            <span className="min-w-0 flex-1 text-14">
              <span className="font-medium">Your browser checks it.</span>{" "}
              <span className="text-ink-2">
                Ed25519 in WebCrypto, with the public key from{" "}
                <a href="/.well-known/dogfood-keys.json" className="underline underline-offset-4">
                  /.well-known/dogfood-keys.json
                </a>
                .
              </span>
              {outcome && outcome.browser.at !== "valid" ? (
                <span className="mt-1 block text-13 text-ink-2">{outcome.browser.at === "checking" ? "Checking." : outcome.browser.why}</span>
              ) : outcome && outcome.browser.at === "valid" ? (
                <span className="mt-1 block font-mono text-12 text-ink-2">{outcome.browser.kid}</span>
              ) : null}
            </span>
            <StepMark mark={browserMark} />
          </li>
          <li className="flex gap-3 py-3">
            <span className="font-mono text-12 leading-5 text-ink-3">03</span>
            <span className="min-w-0 flex-1 text-14">
              <span className="font-medium">The portal checks it too.</span>{" "}
              <span className="text-ink-2">The same bytes, the same key, on the server.</span>
              {outcome && !outcome.portal.valid ? <span className="mt-1 block text-13 text-ink-2">It says: {outcome.portal.reason}.</span> : null}
            </span>
            <StepMark mark={portalMark} />
          </li>
        </ol>
        <p className="mt-3 text-13 text-ink-3">Nothing you paste is stored: the portal only answers valid or not valid.</p>
      </aside>
    </div>
  );
}
