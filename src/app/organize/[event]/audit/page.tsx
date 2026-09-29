import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { HashGlyph, hashGroups } from "@/components/figures/hash-glyph";
import { chainBrokenText, chainHeading, keepHeadText, missingIn } from "@/components/audit-chain";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { checkSavedHead, currentActor, getAuditLog, HttpError, type AuditLine, type SavedHeadCheck } from "@/server/dal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { exportHref } from "@/lib/export-href";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit log" };

// The log drawn as what it is: a hash chain. Each row is a node on one line, its
// hash drawn as bits beside its number; the line runs from the head of the whole
// log down to the first row, which links to 64 zeros. Rows of the log that belong
// to no event or another event sit between this event's rows: the line runs
// through them (dashed), because the chain is one for the whole portal.

const refusal = (l: AuditLine) => l.action.endsWith(".refused");

/** "#2" or "#12 to #15": the rows between two of this event's rows. */
function between(newer: number, older: number): string | null {
  if (newer - older <= 1) return null;
  return newer - older === 2 ? `#${older + 1}` : `#${older + 1} to #${newer - 1}`;
}

function Sentence({ l }: { l: AuditLine }) {
  return (
    <>
      {l.parts.map((p, i) =>
        p.mono ? (
          <span key={i} className="font-mono text-12 text-ink-2">
            {p.text}
          </span>
        ) : p.strong ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
      .
    </>
  );
}

/** A run: consecutive rows of the log (no row between them) with the same action by the same actor. */
const sameRun = (a: AuditLine, b: AuditLine) => a.id - b.id === 1 && a.action === b.action && a.actor === b.actor;

/** The shortest run whose middle folds: its newest and oldest rows stay in view, the rest sit behind one line. */
const FOLD_AT = 5;

type Item = { kind: "row"; l: AuditLine } | { kind: "fold"; rows: AuditLine[] };

/** Lines, newest first, with the middle of every long run folded into one item. */
function fold(lines: AuditLine[]): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && sameRun(lines[j], lines[j + 1])) j++;
    if (j - i + 1 >= FOLD_AT) {
      items.push({ kind: "row", l: lines[i] }, { kind: "fold", rows: lines.slice(i + 1, j) }, { kind: "row", l: lines[j] });
    } else {
      for (let k = i; k <= j; k++) items.push({ kind: "row", l: lines[k] });
    }
    i = j + 1;
  }
  return items;
}

/** One row of the log on the rail: its hash drawn and written, its time, its sentence, its action. */
function Row({ l, up, down, brokenFrom }: { l: AuditLine; up: "solid" | "dashed"; down: "solid" | null; brokenFrom: number | null }) {
  const broken = brokenFrom !== null && l.id >= brokenFrom;
  return (
    <li className={`grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4 ${refusal(l) ? "text-ink-2" : ""}`}>
      <Rail up={up} down={down} node={refusal(l) ? "refusal" : "row"} broken={broken} />
      <div className="grid gap-x-5 gap-y-1 py-3 md:grid-cols-[150px_150px_minmax(0,1fr)_auto]">
        <p className="flex items-center gap-2.5 font-mono text-12 text-ink-2" title={l.hash}>
          <HashGlyph hash={l.hash} />
          <span>
            <span className="text-ink">#{l.id}</span> {l.hash.slice(0, 8)}
          </span>
        </p>
        <p className="font-mono text-12 whitespace-nowrap text-ink-2 md:pt-px">{formatUtc(l.at).replace(" UTC", "")}</p>
        <p className="text-14 leading-5 wrap-anywhere">
          <Sentence l={l} />
          {brokenFrom === l.id ? <span className="ml-2 text-13 font-medium text-flag">The chain breaks here.</span> : null}
        </p>
        <p className="font-mono text-12 text-ink-3 md:pt-px md:text-right">{l.action}</p>
      </div>
    </li>
  );
}

/** The folded middle of a run: one line naming it, each row's own hash drawn small, and the rows behind a disclosure. */
function Fold({ rows, brokenFrom }: { rows: AuditLine[]; brokenFrom: number | null }) {
  const newest = rows[0];
  const oldest = rows.at(-1)!;
  const broken = brokenFrom !== null && newest.id >= brokenFrom;
  const toggle = "ml-3 text-13 font-medium whitespace-nowrap text-ink underline decoration-edge underline-offset-[3px] group-hover:decoration-ink";
  return (
    <li className="border-t border-rule">
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4 [&::-webkit-details-marker]:hidden">
          <Rail up="solid" down="solid" node="run" broken={broken} />
          <div className="flex min-w-0 flex-col gap-2.5 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
              <p className="text-14 leading-5">
                <span className="font-semibold">{plural(rows.length, "more row", "more rows")}</span> of the same kind,{" "}
                <span className="font-mono text-12 whitespace-nowrap text-ink-2">
                  #{oldest.id} to #{newest.id}
                </span>
                <span className={`${toggle} group-open:hidden`}>Show them</span>
                <span className={`${toggle} hidden group-open:inline`}>Fold them</span>
              </p>
              <p className="font-mono text-12 text-ink-3">
                {newest.action} &times; {rows.length}
              </p>
            </div>
            {/* Each row's own hash, its first four digits, newest first: a run is many links, not one. */}
            <p className="flex flex-wrap gap-x-1 gap-y-1.5 group-open:hidden" aria-hidden>
              {rows.map((r) => (
                <HashGlyph key={r.id} hash={r.hash} digits={4} />
              ))}
            </p>
          </div>
        </summary>
        <ol>
          {rows.map((r) => (
            <Row key={r.id} l={r} up="solid" down="solid" brokenFrom={brokenFrom} />
          ))}
        </ol>
      </details>
    </li>
  );
}

/** The rail: the chain's line through this row, with the row's node on it. */
function Rail({ up, down, node, broken }: { up: "solid" | "dashed" | null; down: "solid" | "dashed" | null; node: "row" | "refusal" | "run" | "head" | "genesis" | "gap" | "more"; broken?: boolean }) {
  const line = (kind: "solid" | "dashed") =>
    kind === "solid" ? (broken ? "border-l-2 border-dashed border-flag-bar" : "border-l-2 border-ink-3") : "border-l-2 border-dotted border-edge";
  return (
    <span aria-hidden className="relative block w-6 self-stretch">
      {up ? <span className={`absolute top-0 left-[11px] h-[22px] ${line(up)}`} /> : null}
      {down ? <span className={`absolute top-[22px] bottom-0 left-[11px] ${line(down)}`} /> : null}
      {node === "row" ? (
        <span className={`absolute top-[17px] left-[7px] size-[10px] ${broken ? "border-2 border-flag-bar bg-flag-bg" : "bg-ink"}`} />
      ) : node === "refusal" ? (
        <span className="absolute top-[17px] left-[7px] size-[10px] border-2 border-ink-3 bg-surface" />
      ) : node === "run" ? (
        <>
          <span className="absolute top-[12px] left-[11px] size-[10px] border-[1.5px] border-ink-3 bg-surface" />
          <span className={`absolute top-[17px] left-[7px] size-[10px] ${broken ? "border-2 border-flag-bar bg-flag-bg" : "bg-ink"}`} />
        </>
      ) : node === "head" ? (
        <span className="absolute top-[14px] left-[4px] size-4 rotate-45 border-2 border-ink bg-surface" />
      ) : node === "genesis" ? (
        <span className="absolute top-[14px] left-[4px] size-4 border-2 border-ink bg-surface" />
      ) : null}
    </span>
  );
}

type Show = "all" | "changes" | "refused";

/** A head the organizer typed into "Check a head you saved": its answer, what was wrong with it, or nothing asked yet. */
type HeadAnswer = { kind: "idle" } | ({ kind: "checked" } & SavedHeadCheck) | { kind: "invalid"; message: string; fields: string[] };

function askHead(load: () => SavedHeadCheck): HeadAnswer {
  try {
    return { kind: "checked", ...load() };
  } catch (err) {
    if (err instanceof HttpError && err.status === 422) return { kind: "invalid", message: err.message, fields: Object.keys((err.details ?? {}) as object) };
    throw err;
  }
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function AuditPage({ params, searchParams }: PageProps<"/organize/[event]/audit">) {
  const { event: key } = await params;
  const { show: showParam, entry: entryParam, hash: hashParam } = await searchParams;
  const show: Show = showParam === "refused" || showParam === "changes" ? showParam : "all";
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, lines, total, chain } = guardPage(() => getAuditLog(actor, key));
  // "Check a head you saved" is a plain GET form, like the views: the answer is server-rendered at its own address.
  const savedEntry = one(entryParam);
  const savedHash = one(hashParam);
  const head: HeadAnswer =
    savedEntry !== undefined || savedHash !== undefined
      ? guardPage(() => askHead(() => checkSavedHead(actor, event.id, { entry: savedEntry ?? "", hash: savedHash ?? "" })))
      : { kind: "idle" };
  const isHead = chain.ok && lines[0]?.hash === chain.head;
  const reachesGenesis = lines.at(-1)?.id === 1;
  const olderHidden = total > lines.length;
  const brokenFrom = chain.ok ? null : chain.brokenAtId;
  // A view is a plain link (?show=), so every view is server-rendered and has its own address.
  const refusals = lines.filter(refusal).length;
  const changes = lines.length - refusals;
  const visible = show === "all" ? lines : lines.filter((l) => (show === "refused") === refusal(l));
  const items = fold(visible);
  const filtered = show !== "all";
  // In a filtered view the chain still runs through the rows it leaves out: above the first shown row,
  // and below the last one down to row #1.
  const topGap = filtered && visible[0] && lines[0] ? between(lines[0].id + 1, visible[0].id) : null;
  const bottomGap = filtered && reachesGenesis && visible.length ? between(visible.at(-1)!.id, 0) : null;
  const topMissing = filtered && visible[0] && lines[0] ? missingIn(chain, lines[0].id + 1, visible[0].id) : null;
  // rows the chain says are missing (Fig. 01) above the event's newest row
  const missingAbove = lines[0] ? missingIn(chain, Number.MAX_SAFE_INTEGER, lines[0].id) : null;
  const bottomMissing = filtered && reachesGenesis && visible.length ? missingIn(chain, visible.at(-1)!.id, 0) : null;
  // rows the chain says are missing (Fig. 01) are named as such, never as rows the chain runs through
  const gapText = (g: string, missing: string | null) =>
    `${g}: ${filtered ? "not in this view" : "outside this event"}${missing ? `, but ${missing}` : `; the chain runs through ${g.includes(" to ") ? "them" : "it"}`}`;
  const href = (v: Show) => `/organize/${event.slug}/audit${v === "all" ? "" : `?show=${v}`}`;
  const chip =
    "group inline-flex items-baseline gap-1.5 rounded-sm border border-edge px-3 py-1 text-13 hover:border-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface";
  const count = "tnum text-ink-3 group-aria-[current=page]:text-surface";
  const none = "inline-flex items-baseline gap-1.5 rounded-sm border border-dashed border-rule px-3 py-1 text-13 text-ink-3";
  const gapRow = (g: string, key: string, missing: string | null, down: "dashed" | null = "dashed") => (
    <li key={key} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
      <Rail up="dashed" down={down} node="gap" />
      <p className="py-2 font-mono text-12 text-ink-3">{gapText(g, missing)}</p>
    </li>
  );
  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Audit log")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-24 font-semibold">Audit log</h1>
            <p className="mt-2 max-w-[760px] text-15 text-ink-2">
              Every change, and every request refused to someone signed in or holding a voting link, in the same transaction as the change itself.
              Rows cannot be edited or deleted through the app: the database refuses it. Each row carries the hash of the one before, so a rewritten
              history no longer matches a head hash you kept.
            </p>
          </div>
          <a
            href={exportHref(event.id, "audit.csv")}
            className="inline-flex h-9 items-center rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised"
          >
            Download audit.csv
          </a>
        </header>

        {/* The seal: the verification in words, and the head hash drawn as its 256 bits. */}
        <section
          aria-labelledby="chain-state"
          className={`grid gap-x-8 gap-y-5 rounded-sm border p-5 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] ${chain.ok ? "border-rule bg-surface" : "border-flag-bar border-l-[3px] bg-flag-bg"}`}
        >
          <div className="flex flex-col gap-2" role="status">
            <p className="label-mono text-ink-2">Fig. 01 — The chain</p>
            <h2 id="chain-state" className={`flex items-center gap-2.5 text-20 font-semibold ${chain.ok ? "" : "text-flag"}`}>
              {chain.ok ? (
                <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden>
                  <rect x="1" y="1" width="18" height="18" className="fill-none stroke-ok" strokeWidth="2" />
                  <path d="M5.5 10.5l3 3 6-7" className="fill-none stroke-ok" strokeWidth="2" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" className="size-5 shrink-0" aria-hidden>
                  <rect x="1" y="1" width="18" height="18" className="fill-none stroke-flag-bar" strokeWidth="2" />
                  <path d="M6 6l8 8M14 6l-8 8" className="fill-none stroke-flag-bar" strokeWidth="2" />
                </svg>
              )}
              {chainHeading(chain)}
            </h2>
            <p className="text-14 text-ink-2">
              {chain.ok ? (
                <>
                  Recomputed from the first row on this request: {plural(chain.rows, "row")} in the whole log, each hash matching the row before it.
                </>
              ) : (
                <>{chainBrokenText(chain)}</>
              )}
            </p>
          </div>
          {chain.ok ? (
            <div className="flex min-w-0 flex-col gap-2.5">
              <p className="label-mono text-ink-2">Head hash</p>
              <HashGlyph hash={chain.head} digits={64} groupEvery={8} className="h-auto w-full max-w-[566px]" />
              {/* 13px mono plus 0.2px tracking is 8px a digit, and the groups sit 8px apart like the glyph's:
                  on wider screens each digit sits under its own column of bits. */}
              <p className="flex max-w-[600px] flex-wrap gap-x-3 font-mono text-13 tracking-[0.2px] text-ink sm:gap-x-2">
                {hashGroups(chain.head).map((g, i) => (
                  <span key={i} className="sm:w-16">
                    {g}
                  </span>
                ))}
              </p>
              <p className="text-12 text-ink-3">
                {keepHeadText(chain.rows, "below")}
              </p>
            </div>
          ) : null}
        </section>

        <section id="check-head" aria-labelledby="check-head-title" className="flex scroll-mt-4 flex-col gap-3 rounded-sm border border-rule bg-surface p-5">
          <div>
            <h2 id="check-head-title" className="text-17 font-semibold">
              Check a head you saved
            </h2>
            <p className="mt-1 max-w-[760px] text-14 text-ink-2">
              A row number and its hash, from this page, an earlier audit.csv (chain_head_entry and chain_head) or a signed record. The answer is only
              whether the log still holds that row with that hash.
            </p>
          </div>
          <form method="get" action={`/organize/${event.slug}/audit#check-head`} className="flex flex-wrap items-end gap-3">
            {show !== "all" ? <input type="hidden" name="show" value={show} /> : null}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="head-entry" className="text-14 font-medium">
                Row
              </label>
              <Input
                id="head-entry"
                name="entry"
                inputMode="numeric"
                autoComplete="off"
                placeholder="412"
                defaultValue={savedEntry ?? ""}
                aria-invalid={head.kind === "invalid" && head.fields.includes("entry") ? true : undefined}
                aria-describedby="check-head-answer"
                className="w-28 font-mono"
              />
            </div>
            <div className="flex min-w-0 flex-1 basis-[420px] flex-col gap-1.5">
              <label htmlFor="head-hash" className="text-14 font-medium">
                Hash
              </label>
              <Input
                id="head-hash"
                name="hash"
                autoComplete="off"
                spellCheck={false}
                placeholder="64 hex digits"
                defaultValue={savedHash ?? ""}
                aria-invalid={head.kind === "invalid" && head.fields.includes("hash") ? true : undefined}
                aria-describedby="check-head-answer"
                className="font-mono text-13"
              />
            </div>
            <Button type="submit" variant="outline" size="lg">
              Check
            </Button>
          </form>
          {/* One line kept for the answer, so the form does not move when one arrives. */}
          <p id="check-head-answer" role="status" className="flex min-h-5 items-start gap-2 text-14">
            {head.kind === "idle" ? (
              <span className="text-ink-3">The answer shows here: holds, or does not hold.</span>
            ) : head.kind === "invalid" ? (
              <span className="font-medium text-flag">{head.message}</span>
            ) : head.holds ? (
              <>
                <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" aria-hidden>
                  <rect x="1" y="1" width="18" height="18" className="fill-none stroke-ok" strokeWidth="2" />
                  <path d="M5.5 10.5l3 3 6-7" className="fill-none stroke-ok" strokeWidth="2" />
                </svg>
                <span>
                  <strong className="font-semibold text-ok">Holds.</strong> Row #{head.entry} still carries this hash, so nothing up to it was rewritten or
                  cut since you saved it.
                </span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 20 20" className="mt-0.5 size-4 shrink-0" aria-hidden>
                  <rect x="1" y="1" width="18" height="18" className="fill-none stroke-flag-bar" strokeWidth="2" />
                  <path d="M6 6l8 8M14 6l-8 8" className="fill-none stroke-flag-bar" strokeWidth="2" />
                </svg>
                <span>
                  <strong className="font-semibold text-flag">Does not hold.</strong> The log no longer has row #{head.entry} with this hash. If you copied both
                  whole, something up to row #{head.entry} was rewritten or cut since you saved it: treat the log from there on as unverified.
                </span>
              </>
            )}
          </p>
        </section>

        <section aria-labelledby="rows-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="rows-title" className="label-mono text-ink">
              Fig. 02 — This event&rsquo;s rows, newest first
            </h2>
            <p className="flex items-center gap-1.5 text-12 text-ink-3" aria-hidden>
              <span className="inline-block h-3 border-l-2 border-dotted border-edge" /> rows outside this event or this view
            </p>
          </div>
          <nav aria-label="Show rows" className="flex flex-wrap gap-1.5">
            <Link href={href("all")} aria-current={show === "all" ? "page" : undefined} className={chip}>
              All <span className={count}>{lines.length}</span>
            </Link>
            {changes ? (
              <Link href={href("changes")} aria-current={show === "changes" ? "page" : undefined} className={chip}>
                <span className="inline-block size-2 self-center bg-ink group-aria-[current=page]:bg-surface" aria-hidden />
                Changes <span className={count}>{changes}</span>
              </Link>
            ) : (
              <span className={none}>No changes</span>
            )}
            {refusals ? (
              <Link href={href("refused")} aria-current={show === "refused" ? "page" : undefined} className={chip}>
                <span className="inline-block size-2 self-center border-[1.5px] border-ink-3 group-aria-[current=page]:border-surface" aria-hidden />
                Refused requests <span className={count}>{refusals}</span>
              </Link>
            ) : (
              <span className={none}>
                <span className="inline-block size-2 self-center border-[1.5px] border-rule" aria-hidden />
                No refused requests
              </span>
            )}
          </nav>
          <ol className="rounded-sm border border-rule bg-surface px-3 sm:px-5">
            <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
              <Rail up={null} down={isHead && !topGap ? "solid" : "dashed"} node={isHead ? "head" : "more"} />
              <p className="py-3 text-13 text-ink-2">
                {isHead ? (
                  <>
                    <span className="label-mono mr-2 text-ink">Head</span>This event&rsquo;s latest row is the newest row of the whole log.
                  </>
                ) : (
                  <>
                    The log goes on past this event&rsquo;s latest row: newer rows belong to other events or to the portal
                    {missingAbove ? `, but ${missingAbove}` : ""}.
                  </>
                )}
              </p>
            </li>
            {topGap ? gapRow(topGap, "gap-top", topMissing) : null}
            {items.length === 0 ? (
              <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4">
                <Rail up="dashed" down={reachesGenesis || olderHidden ? "dashed" : null} node="gap" />
                <p className="py-3 text-14 text-ink-2">
                  {show === "refused" ? "No request was refused in this event." : "No changes in this event's log."}{" "}
                  <Link href={href("all")} className="font-medium text-ink underline decoration-edge underline-offset-[3px] hover:decoration-ink">
                    Show all rows
                  </Link>
                </p>
              </li>
            ) : null}
            {items.map((it, i) => {
              const newest = it.kind === "row" ? it.l : it.rows[0];
              const next = items[i + 1];
              const older = next ? (next.kind === "row" ? next.l : next.rows[0]) : null;
              const gap = older ? between(it.kind === "row" ? it.l.id : it.rows.at(-1)!.id, older.id) : null;
              const missing = older ? missingIn(chain, it.kind === "row" ? it.l.id : it.rows.at(-1)!.id, older.id) : null;
              const last = i === items.length - 1;
              return [
                it.kind === "row" ? (
                  <Row
                    key={it.l.id}
                    l={it.l}
                    up={i === 0 && (!isHead || topGap) ? "dashed" : "solid"}
                    down={last && !reachesGenesis && !olderHidden ? null : "solid"}
                    brokenFrom={brokenFrom}
                  />
                ) : (
                  <Fold key={`fold-${it.rows[0].id}`} rows={it.rows} brokenFrom={brokenFrom} />
                ),
                gap ? gapRow(gap, `gap-${newest.id}`, missing) : null,
              ];
            })}
            {bottomGap ? gapRow(bottomGap, "gap-bottom", bottomMissing) : null}
            {reachesGenesis ? (
              <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4">
                <Rail up={bottomGap || !items.length ? "dashed" : "solid"} down={null} node="genesis" />
                <p className="py-3 text-13 text-ink-2">
                  <span className="label-mono mr-2 text-ink">Genesis</span>Row #1 links to a hash of 64 zeros, the chain&rsquo;s fixed start.
                </p>
              </li>
            ) : olderHidden ? (
              <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4">
                <Rail up="dashed" down={null} node="more" />
                <p className="py-3 text-13 text-ink-2">Older rows of this event are in audit.csv.</p>
              </li>
            ) : null}
          </ol>
        </section>
        <p className="text-13 text-ink-2">
          Showing the latest {lines.length} of {plural(total, "entry", "entries")} for this event; audit.csv has all of them, oldest first, each with its own hash and the one before.
        </p>
      </div>
    </WorkShell>
  );
}
