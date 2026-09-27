"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DitherDigits } from "@/components/dither-digits";
import { SignatureBits } from "@/components/signature-bits";
import { formatUtc } from "@/lib/format";
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

/** "Joint 1st place, Health" back into its parts, from the award text the signed record carries. */
function placeOf(award: string): { place: number; ordinal: string; joint: boolean; track: string } | null {
  const m = /^(Joint )?(([0-9]+)(?:st|nd|rd|th)) place, (.+)$/.exec(award);
  return m ? { joint: Boolean(m[1]), ordinal: m[2]!, place: Number(m[3]), track: m[4]! } : null;
}

const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

type Mark = "ok" | "bad" | "idle";
function StepMark({ mark }: { mark: Mark }) {
  if (mark === "ok") return <Check className="size-4 text-ok" aria-label="passed" />;
  if (mark === "bad") return <X className="size-4 text-flag" aria-label="failed" />;
  return <Minus className="size-4 text-ink-3" aria-hidden />;
}

type SealState = "unchecked" | "checking" | "valid" | "invalid";

/**
 * The record's seal, drawn live in the figure: the signature itself, one square per bit.
 * Before anything is pasted it is an empty, hatched slot the size of the 512 bits; once a
 * record is read its bits appear in grey; they light up when both checks pass, and the
 * frame turns to the alarm colour when they fail.
 */
function SealFigure({ signature, state }: { signature: string | null; state: SealState }) {
  const drawn = signature ? <SignatureBits signature={signature} lit={state === "valid"} /> : null;
  return (
    <figure className="mt-4 flex flex-col gap-2 max-lg:max-w-[320px]" data-seal={drawn ? state : "empty"}>
      <div
        className={`overflow-hidden rounded-xs border transition-colors duration-500 motion-reduce:transition-none ${
          !drawn ? "border-dashed border-edge" : state === "valid" ? "border-accent" : state === "invalid" ? "border-2 border-flag-bar" : "border-rule"
        }`}
      >
        {drawn ?? <div aria-hidden className="sealed aspect-[34/18] w-full" />}
      </div>
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="label-mono text-ink-3">The seal · 512 bits</span>
        <span className="text-13 text-ink-2">
          {!drawn ? (
            "drawn from the signature you paste"
          ) : state === "valid" ? (
            <span className="inline-flex items-center gap-1 font-semibold text-ok">
              <Check className="size-4" aria-hidden /> Valid
            </span>
          ) : state === "invalid" ? (
            <span className="inline-flex items-center gap-1 font-semibold text-flag">
              <X className="size-4" aria-hidden /> Not valid
            </span>
          ) : state === "checking" ? (
            "checking…"
          ) : (
            "not checked yet"
          )}
        </span>
      </figcaption>
    </figure>
  );
}

export function VerifyForm() {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);

  // The answer lands below the box: bring it into view once it is there.
  useEffect(() => {
    if (!outcome) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [outcome]);

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
  const project = outcome?.record.project as
    | { id?: string; title?: string; team?: string; track?: string; awards?: string[] }
    | undefined;
  const judging =
    outcome?.record.kind === "judge" ? (outcome.record.judging as { finishedReviews?: number; answers?: number; tracks?: string[] } | undefined) : undefined;
  const heading = outcome?.record.kind === "judge" ? "Judging record" : project?.awards?.length ? "Certificate of achievement" : "Certificate of participation";
  const pasted = text.trim() ? envelopeOf(text) : null;
  const parsed = text.trim() ? pasted !== null : null;
  const sealState: SealState = busy ? "checking" : !outcome ? "unchecked" : valid ? "valid" : "invalid";
  const pastedKind = pasted?.record.kind === "judge" ? "A judging record" : "A certificate";
  const pastedName = (pasted?.record.person as { name?: unknown } | undefined)?.name;
  const pastedId = typeof pasted?.record.id === "string" ? pasted.record.id : null;
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
        <div ref={resultRef} role="status" aria-live="polite" className="scroll-mb-6">
          {problem ? <p className="rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">{problem}</p> : null}
          {outcome ? (
            valid ? (
              <article
                aria-label="Result"
                className="corner-marks lit stamp mt-2 flex flex-col gap-5 rounded-sm border border-accent px-6 py-7 [--mark:var(--accent)] sm:px-9 sm:py-8"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <p className="label-mono flex items-center gap-2 text-ok">
                    <Check className="size-4" aria-hidden /> Valid · {heading}
                  </p>
                  {id ? <p className="font-mono text-12 text-ink-3">{id}</p> : null}
                </div>
                <div className="flex min-w-0 flex-col gap-2 wrap-anywhere">
                  <p className="font-serif text-38 leading-[1.1]">{person ?? "someone"}</p>
                  <p className="font-serif text-17 leading-[1.5] text-ink-2 sm:text-20">
                    {judging ? (
                      <>
                        {judging.finishedReviews ? (
                          <>
                            reviewed <strong className="font-semibold text-ink">{judging.finishedReviews}</strong>{" "}
                            {judging.finishedReviews === 1 ? "project" : "projects"}
                            {judging.answers ? " and " : " "}
                          </>
                        ) : null}
                        {judging.answers ? (
                          <>
                            gave <strong className="font-semibold text-ink">{judging.answers}</strong> pairwise{" "}
                            {judging.answers === 1 ? "answer" : "answers"}{" "}
                          </>
                        ) : null}
                        as a judge for <strong className="font-semibold text-ink">{event ?? "an event"}</strong>
                        {judging.tracks?.length ? `, in the ${andList(judging.tracks)} ${judging.tracks.length === 1 ? "track" : "tracks"}` : ""}.
                      </>
                    ) : project ? (
                      <>
                        was a member of <strong className="font-semibold text-ink">{project.team}</strong>, who built{" "}
                        <strong className="font-semibold text-ink">{project.title}</strong> for{" "}
                        <strong className="font-semibold text-ink">{event ?? "an event"}</strong>
                        {project.track ? `, in the ${project.track} track` : ""}.
                      </>
                    ) : (
                      <>
                        for <strong className="font-semibold text-ink">{event ?? "an event"}</strong>.
                      </>
                    )}
                  </p>
                </div>
                {project?.awards?.length ? (
                  <ul className="flex flex-col gap-4 border-t border-rule pt-5 wrap-anywhere">
                    {project.awards.map((a) => {
                      const p = placeOf(a);
                      return (
                        <li key={a} className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-x-5 sm:grid-cols-[56px_minmax(0,1fr)]">
                          {p ? <DitherDigits value={String(p.place)} className="[&_path]:fill-accent" /> : <span aria-hidden className="block aspect-square w-full bg-accent" />}
                          <p className="flex flex-col gap-0.5">
                            <span className="font-display text-20 uppercase leading-tight text-accent-ink sm:text-24">{p ? `${p.joint ? "Joint " : ""}${p.ordinal} place` : a}</span>
                            {p ? <span className="font-serif text-15 text-ink-2 sm:text-17">in the {p.track} track</span> : null}
                          </p>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <dl className="grid gap-1.5 border-t border-rule pt-4 text-14 max-sm:[&>div]:grid max-sm:[&>div]:grid-cols-[80px_minmax(0,1fr)] max-sm:[&>div]:gap-3 sm:grid-cols-3 sm:gap-4">
                  <div>
                    <dt className="text-ink-3">Issued</dt>
                    <dd>{typeof outcome.record.issuedAt === "string" ? formatUtc(outcome.record.issuedAt) : "not given"}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Signed by</dt>
                    <dd className="break-all">{String(outcome.record.issuer ?? "not given")}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Key</dt>
                    <dd className="font-mono text-13">{String(outcome.record.keyId ?? "")} (Ed25519)</dd>
                  </div>
                </dl>
                <p className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 text-14 text-ink-2">
                  <span>Signed by this portal and unchanged since, byte for byte.</span>
                  {id ? (
                    <a href={`/records/${encodeURIComponent(id)}`} className="rounded-xs text-15 font-medium text-ink underline decoration-edge underline-offset-4 hover:decoration-ink">
                      Open the record&rsquo;s page
                    </a>
                  ) : null}
                </p>
              </article>
            ) : (
              <div className="stamp mt-2 rounded-sm border-y border-r border-l-4 border-flag-bar bg-flag-bg px-4 py-3 text-15">
                <p>
                  <strong className="font-semibold text-flag">Not valid.</strong> {outcome.portal.message ?? "The signature does not match this record."}
                </p>
                <p className="mt-2 text-14 text-ink-2">
                  The signature covers every byte: one changed letter is enough to fail the check.
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
        <SealFigure signature={pasted?.signature ?? null} state={sealState} />
        <ol className="mt-4 flex flex-col divide-y divide-rule border-b border-rule">
          <li className="flex gap-3 py-3">
            <span className="font-mono text-12 leading-5 text-ink-3">01</span>
            <span className="min-w-0 flex-1 text-14">
              <span className="font-medium">Read the record.</span>{" "}
              <span className="text-ink-2">Its keys are sorted at every depth and the spaces dropped: those exact bytes were signed.</span>
              {pasted ? (
                <span className="mt-1 block text-13 text-ink-2">
                  {pastedKind}
                  {typeof pastedName === "string" ? ` for ${pastedName}` : ""}
                  {pastedId ? <span className="font-mono text-12"> · {pastedId}</span> : null}
                </span>
              ) : parsed === false ? (
                <span className="mt-1 block text-13 text-ink-2">Not JSON with a record and a signature.</span>
              ) : null}
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
