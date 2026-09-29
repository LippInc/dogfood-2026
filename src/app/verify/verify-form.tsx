"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FileText, Minus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DitherDigits } from "@/components/dither-digits";
import { SignatureBits, bitsOf } from "@/components/signature-bits";
import { formatUtc } from "@/lib/format";
import { awardPlace as placeOf, prizeOf, tieBrokenWords } from "@/lib/places";
import { checkInBrowser } from "../records/[record]/check";

type Envelope = { record: Record<string, unknown>; signature: string };
type Outcome = {
  browser: Awaited<ReturnType<typeof checkInBrowser>>;
  portal: { valid: boolean; reason?: string; message?: string };
  record: Record<string, unknown>;
  signature: string;
  copy?: Copy;
};

/** What the portal's own public copy of a failed record says: which fields differ, or that it never issued that id. */
type Change = { path: string; pasted: string | null; signed: string | null };
type Copy = { at: "none"; id: string } | { at: "changed"; id: string; changes: Change[] } | { at: "signature"; id: string; signed: string };

/** Every leaf of a record as "path -> JSON value", arrays by index. */
function leaves(v: unknown, path = "", out: Record<string, string> = {}): Record<string, string> {
  if (v && typeof v === "object") {
    const entries = Array.isArray(v) ? v.map((x, i) => [`${path}[${i}]`, x] as const) : Object.entries(v).map(([k, x]) => [path ? `${path}.${k}` : k, x] as const);
    for (const [p, x] of entries) leaves(x, p, out);
  } else out[path] = JSON.stringify(v);
  return out;
}

/**
 * When a record fails, ask the portal for its public copy by the record's id (the same
 * GET a record's share link uses) and name what differs. Only the id leaves this page.
 */
async function compareWithCopy(record: Record<string, unknown>, signature: string): Promise<Copy | undefined> {
  const id = record.id;
  if (typeof id !== "string" || !/^rec_[a-z0-9]{1,64}$/.test(id)) return undefined;
  const res = await fetch(`/api/records/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return { at: "none", id };
  if (!res.ok) return undefined;
  const body = (await res.json()) as { envelope?: Envelope; verification?: { valid?: boolean } };
  if (!body.envelope || !body.verification?.valid) return undefined;
  const mine = leaves(record);
  const theirs = leaves(body.envelope.record);
  const changes = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])]
    .filter((k) => mine[k] !== theirs[k])
    .map((k) => ({ path: k, pasted: mine[k] ?? null, signed: theirs[k] ?? null }));
  if (changes.length) return { at: "changed", id, changes };
  const signed = String(body.envelope.signature);
  return signed !== signature ? { at: "signature", id, signed } : undefined;
}

/** A value with the part that differs from the other one marked: the common start and end stay plain. */
function Marked({ value, other, tone }: { value: string | null; other: string | null; tone: "changed" | "signed" }) {
  // The changed letters in the alarm colour, the signed ones in the accent (the page's colour for "genuine").
  const mark = tone === "changed" ? "rounded-[2px] bg-flag-bar px-0.5 text-surface" : "rounded-[2px] bg-accent-tint px-0.5 text-ink";
  if (value === null) return <span className="font-sans text-13 italic text-ink-3">not there</span>;
  if (other === null) return <mark className={mark}>{value}</mark>;
  let a = 0;
  while (a < value.length && a < other.length && value[a] === other[a]) a++;
  let b = 0;
  while (b < value.length - a && b < other.length - a && value[value.length - 1 - b] === other[other.length - 1 - b]) b++;
  return (
    <>
      {value.slice(0, a)}
      <mark className={mark}>{value.slice(a, value.length - b)}</mark>
      {value.slice(value.length - b)}
    </>
  );
}

/** The refusal in one plain sentence: only what the evidence on this page shows. */
function refusalOf(o: Outcome): string {
  if (o.copy?.at === "changed") return "Changed after it was signed.";
  if (o.copy?.at === "signature") return "Its signature was replaced.";
  if (o.copy?.at === "none") return "Not issued by this portal.";
  if (o.portal.reason === "unknown_key") return "Signed with a key this portal does not publish.";
  if (o.portal.reason === "malformed") return "Not a well-formed signed record.";
  return "It does not match its signature.";
}

function envelopeOf(text: string): Envelope | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    const e = parsed && typeof parsed === "object" && "envelope" in parsed ? (parsed as { envelope: unknown }).envelope : parsed;
    if (e && typeof e === "object" && "record" in e && "signature" in e) return e as Envelope;
  } catch {}
  return null;
}

/** How many of the bits of two signatures differ (every bit, when one cannot be read or the lengths differ). */
function bitsApart(a: string, b: string): number {
  const x = bitsOf(a);
  const y = bitsOf(b);
  if (!x || !y) return Math.max(x?.length ?? 0, y?.length ?? 0);
  let n = Math.abs(x.length - y.length);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

const andList = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

type Mark = "ok" | "bad" | "idle";
function StepMark({ mark }: { mark: Mark }) {
  // role="img": an svg with only an aria-label is not announced by every screen reader
  if (mark === "ok") return <Check className="size-4 text-ok" role="img" aria-label="passed" />;
  if (mark === "bad") return <X className="size-4 text-flag" role="img" aria-label="failed" />;
  return <Minus className="size-4 text-ink-3" aria-hidden />;
}

/**
 * The line under a step that says how it went. Every step keeps one from the first paint (a quiet "not yet" until
 * there is something to say), so typing or pasting a record never pushes the steps below it down.
 */
function StepNote({ idle = false, children }: { idle?: boolean; children: React.ReactNode }) {
  return <span className={`mt-1 block text-13 ${idle ? "text-ink-3" : "text-ink-2"}`}>{children}</span>;
}

type SealState = "unchecked" | "checking" | "valid" | "invalid";

/**
 * The record's seal, drawn live in the figure: the signature itself, one square per bit.
 * Before anything is pasted it is an empty, hatched slot the size of the 512 bits; once a
 * record is read its bits appear in grey; they light up when both checks pass, and the
 * frame turns to the alarm colour when they fail.
 */
function SealFigure({ signature, state, against }: { signature: string | null; state: SealState; against?: string }) {
  const drawn = signature ? <SignatureBits signature={signature} lit={state === "valid"} against={against} /> : null;
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
  const [file, setFile] = useState<{ name: string; size: number } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // The answer lands below the box: bring it into view once it is there.
  useEffect(() => {
    if (!outcome) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    resultRef.current?.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [outcome]);

  // Opening or dropping a file is already the request: read it and check it at once.
  async function openFile(f: File) {
    const body = await f.text();
    setText(body);
    setFile({ name: f.name, size: f.size });
    await check(body);
  }

  async function check(source = text) {
    setOutcome(null);
    const envelope = envelopeOf(source);
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
      const signature = String(envelope.signature);
      const failed = !portal.valid || browser.at === "invalid";
      const copy = failed ? await compareWithCopy(envelope.record, signature).catch(() => undefined) : undefined;
      setOutcome({ browser, portal, record: envelope.record, signature, copy });
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
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) await openFile(dropped);
          }}
          className={`relative rounded-sm ${dragging ? "outline-2 outline-offset-2 outline-accent outline-dashed" : ""}`}
        >
          <Textarea
            id="record-text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFile(null);
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
          {file ? (
            <>
              <FileText className="mr-1.5 inline size-4 align-[-3px]" aria-hidden />
              Opened <span className="font-mono text-12 text-ink-2">{file.name}</span> · {file.size < 1024 ? `${file.size} bytes` : `${(file.size / 1024).toFixed(1)} KB`}, checked
              as soon as it opened.
            </>
          ) : (
            "Paste it, open the file, or drop the file on the box."
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="lg" onClick={() => check()} disabled={busy || !text.trim()}>
            {busy ? "Checking…" : "Check the signature"}
          </Button>
          <label className="inline-flex h-10 cursor-pointer items-center rounded-sm border border-edge px-4 text-14 font-medium focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus hover:bg-raised">
            Open a file
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (picked) await openFile(picked);
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
                      const z = p ? null : prizeOf(a);
                      return (
                        <li key={a} className="grid grid-cols-[48px_minmax(0,1fr)] items-center gap-x-5 sm:grid-cols-[56px_minmax(0,1fr)]">
                          {p ? <DitherDigits value={String(p.place)} className="[&_path]:fill-accent" /> : <span aria-hidden className="block aspect-square w-full bg-accent" />}
                          <p className="flex flex-col gap-0.5">
                            <span className="font-display text-20 uppercase leading-tight text-accent-ink sm:text-24">
                              {p ? `${p.joint ? "Joint " : ""}${p.ordinal} place` : z ? (z.joint ? "Joint winner" : "Winner") : a}
                            </span>
                            {p ? <span className="font-serif text-15 text-ink-2 sm:text-17">in the {p.track} track</span> : null}
                            {p?.tieBrokenBy ? <span className="text-13 text-ink-2">{tieBrokenWords(p.tieBrokenBy)}</span> : null}
                            {z ? <span className="font-serif text-15 text-ink-2 sm:text-17">of the prize {z.prize}</span> : null}
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
              <article
                aria-label="Result"
                className="corner-marks stamp mt-2 flex flex-col gap-5 rounded-sm border border-flag-bar bg-flag-bg px-6 py-7 [--mark:var(--flag-bar)] sm:px-9 sm:py-8"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                  <p className="label-mono flex items-center gap-2 text-flag">
                    <X className="size-4" aria-hidden /> Not valid · {outcome.record.kind === "judge" ? "Judging record" : "Certificate"}
                  </p>
                  {id ? <p className="font-mono text-12 text-ink-3">{id}</p> : null}
                </div>
                <div className="flex flex-col gap-2">
                  <p className="font-serif text-24 leading-[1.2] sm:text-38 sm:leading-[1.1]">{refusalOf(outcome)}</p>
                  <p className="text-15 text-ink-2">{outcome.portal.message ?? "The signature does not match this record."}</p>
                </div>
                {outcome.copy?.at === "changed" ? (
                  <div className="flex flex-col gap-2 border-t border-rule pt-5">
                    <p className="text-14">
                      Against the portal&rsquo;s own copy of <span className="font-mono text-13">{outcome.copy.id}</span>,{" "}
                      {outcome.copy.changes.length === 1 ? "one field differs" : `${outcome.copy.changes.length} fields differ`}:
                    </p>
                    <ul className="flex flex-col divide-y divide-rule rounded-sm border border-rule bg-surface">
                      {outcome.copy.changes.slice(0, 6).map((c) => (
                        <li key={c.path} className="grid gap-1.5 px-4 py-3 sm:grid-cols-[160px_minmax(0,1fr)] sm:gap-4">
                          <span className="font-mono text-12 leading-6 text-ink-3 wrap-anywhere">{c.path}</span>
                          <span className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5">
                            <span className="text-13 text-ink-2">This copy</span>
                            <span className="font-mono text-15 wrap-anywhere">
                              <Marked value={c.pasted} other={c.signed} tone="changed" />
                            </span>
                            <span className="text-13 text-ink-2">As signed</span>
                            <span className="font-mono text-15 wrap-anywhere">
                              <Marked value={c.signed} other={c.pasted} tone="signed" />
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {outcome.copy.changes.length > 6 ? <p className="text-13 text-ink-2">And {outcome.copy.changes.length - 6} more.</p> : null}
                  </div>
                ) : outcome.copy?.at === "signature" ? (
                  <p className="border-t border-rule pt-5 text-14 text-ink-2">
                    Every field matches the portal&rsquo;s own copy of <span className="font-mono text-13">{outcome.copy.id}</span>: only the signature differs, in{" "}
                    {bitsApart(outcome.signature, outcome.copy.signed)} of its {bitsOf(outcome.copy.signed)?.length ?? "?"} bits, marked in the seal.
                  </p>
                ) : outcome.copy?.at === "none" ? (
                  <p className="border-t border-rule pt-5 text-14 text-ink-2">
                    This portal holds no record with the id <span className="font-mono text-13">{outcome.copy.id}</span>, so it did not issue this one.
                  </p>
                ) : null}
                <p className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-rule pt-4 text-14 text-ink-2">
                  <span>The signature covers every byte: one changed letter is enough to fail the check.</span>
                  {outcome.copy && outcome.copy.at !== "none" ? (
                    <a
                      href={`/records/${encodeURIComponent(outcome.copy.id)}`}
                      className="rounded-xs text-15 font-medium text-ink underline decoration-edge underline-offset-4 hover:decoration-ink"
                    >
                      Open the signed original
                    </a>
                  ) : null}
                </p>
              </article>
            )
          ) : null}
        </div>
      </div>

      <aside aria-labelledby="how-title" className="self-start border-t-2 border-ink pt-3">
        <h2 id="how-title" className="label-mono text-ink">
          Fig. 01 — What the check does
        </h2>
        <SealFigure
          signature={pasted?.signature ?? null}
          state={sealState}
          against={outcome?.copy?.at === "signature" && pasted?.signature === outcome.signature ? outcome.copy.signed : undefined}
        />
        <ol className="mt-4 flex flex-col divide-y divide-rule border-b border-rule">
          <li className="flex gap-3 py-3">
            <span className="font-mono text-12 leading-5 text-ink-3">01</span>
            <span className="min-w-0 flex-1 text-14">
              <span className="font-medium">Read the record.</span>{" "}
              <span className="text-ink-2">Its keys are sorted at every depth and the spaces dropped: those exact bytes were signed.</span>
              {pasted ? (
                <StepNote>
                  {pastedKind}
                  {typeof pastedName === "string" ? ` for ${pastedName}` : ""}
                  {pastedId ? <span className="font-mono text-12"> · {pastedId}</span> : null}
                </StepNote>
              ) : parsed === false ? (
                <StepNote>Not JSON with a record and a signature.</StepNote>
              ) : (
                <StepNote idle>Waiting for a record.</StepNote>
              )}
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
                <StepNote>{outcome.browser.at === "checking" ? "Checking." : outcome.browser.why}</StepNote>
              ) : outcome && outcome.browser.at === "valid" ? (
                <StepNote>
                  <span className="font-mono text-12">{outcome.browser.kid}</span>
                </StepNote>
              ) : (
                <StepNote idle>{busy ? "Checking." : "Runs when you check."}</StepNote>
              )}
            </span>
            <StepMark mark={browserMark} />
          </li>
          <li className="flex gap-3 py-3">
            <span className="font-mono text-12 leading-5 text-ink-3">03</span>
            <span className="min-w-0 flex-1 text-14">
              <span className="font-medium">The portal checks it too.</span>{" "}
              <span className="text-ink-2">The same bytes, the same key, on the server.</span>
              {outcome ? (
                <StepNote>
                  It says: <span className="font-mono text-12">{outcome.portal.valid ? "valid" : outcome.portal.reason}</span>
                </StepNote>
              ) : (
                <StepNote idle>{busy ? "Checking." : "Runs when you check."}</StepNote>
              )}
            </span>
            <StepMark mark={portalMark} />
          </li>
        </ol>
        <p className="mt-3 text-13 text-ink-3">
          Nothing you paste is stored: the portal only answers valid or not valid. When a record fails, this page asks the portal for its public copy by the
          record&rsquo;s id, to show what changed.
        </p>
      </aside>
    </div>
  );
}
