"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { checkInBrowser } from "../records/[record]/check";

type Envelope = { record: Record<string, unknown>; signature: string };
type Outcome = {
  browser: Awaited<ReturnType<typeof checkInBrowser>>;
  portal: { valid: boolean; reason?: string; message?: string };
  record: Record<string, unknown>;
};

function envelopeOf(text: string): Envelope | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const e = parsed && typeof parsed === "object" && "envelope" in parsed ? (parsed as { envelope: unknown }).envelope : parsed;
    if (e && typeof e === "object" && "record" in e && "signature" in e) return e as Envelope;
  } catch {}
  return null;
}

export function VerifyForm() {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        checkInBrowser(envelope),
        fetch("/api/records/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope) }).then((r) => r.json()),
      ]);
      setOutcome({ browser, portal, record: envelope.record });
    } catch {
      setProblem("The check could not run. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const person = (outcome?.record.person as { name?: string } | undefined)?.name;
  const event = (outcome?.record.event as { name?: string } | undefined)?.name;
  const valid = outcome?.portal.valid && outcome.browser.at !== "invalid";
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor="record-text" className="text-14 font-medium">
        The record (JSON)
      </label>
      <Textarea
        id="record-text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        spellCheck={false}
        className="font-mono text-12"
        placeholder='{ "record": { ... }, "signature": "..." }'
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={check} disabled={busy || !text.trim()}>
          {busy ? "Checking…" : "Check the signature"}
        </Button>
        <label className="inline-flex h-10 cursor-pointer items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-raised">
          Open a file
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) setText(await file.text());
            }}
          />
        </label>
      </div>
      <div role="status" aria-live="polite">
        {problem ? <p className="rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">{problem}</p> : null}
        {outcome ? (
          <div className={`rounded-sm border-y border-r border-l-4 px-4 py-3 text-15 ${valid ? "border-ok" : "border-flag-bar bg-flag-bg"}`}>
            <p>
              <strong className={`font-semibold ${valid ? "text-ok" : "text-flag"}`}>{valid ? "Valid." : "Not valid."}</strong>{" "}
              {valid
                ? `A ${outcome.record.kind === "judge" ? "judging record" : "certificate"} for ${person ?? "someone"}, ${event ?? "an event"}, signed by this portal and unchanged since.`
                : (outcome.portal.message ?? "The signature does not match this record.")}
            </p>
            <p className="mt-2 text-14 text-ink-2">
              Your browser says:{" "}
              {outcome.browser.at === "valid"
                ? `valid, with key ${outcome.browser.kid}.`
                : outcome.browser.at === "invalid"
                  ? `not valid. ${outcome.browser.why}`
                  : outcome.browser.at === "unsupported"
                    ? outcome.browser.why
                    : "checking."}{" "}
              The portal says: {outcome.portal.valid ? "valid." : `not valid (${outcome.portal.reason}).`}
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
