import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { HashGlyph, hashGroups } from "@/components/figures/hash-glyph";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getAuditLog, type AuditLine } from "@/server/dal";
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

/** The rail: the chain's line through this row, with the row's node on it. */
function Rail({ up, down, node, broken }: { up: "solid" | "dashed" | null; down: "solid" | "dashed" | null; node: "row" | "refusal" | "head" | "genesis" | "gap" | "more"; broken?: boolean }) {
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
      ) : node === "head" ? (
        <span className="absolute top-[14px] left-[4px] size-4 rotate-45 border-2 border-ink bg-surface" />
      ) : node === "genesis" ? (
        <span className="absolute top-[14px] left-[4px] size-4 border-2 border-ink bg-surface" />
      ) : null}
    </span>
  );
}

export default async function AuditPage({ params }: PageProps<"/organize/[event]/audit">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, lines, total, chain } = guardPage(() => getAuditLog(actor, key));
  const isHead = chain.ok && lines[0]?.hash === chain.head;
  const reachesGenesis = lines.at(-1)?.id === 1;
  const olderHidden = total > lines.length;
  const brokenFrom = chain.ok ? null : chain.brokenAtId;
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
              {chain.ok ? "Chain verified" : `Chain broken at row #${chain.brokenAtId}`}
            </h2>
            <p className="text-14 text-ink-2">
              {chain.ok ? (
                <>
                  Recomputed from the first row on this request: {plural(chain.rows, "row")} in the whole log, each hash matching the row before it.
                </>
              ) : (
                <>A row was changed outside the app. Treat everything from row #{chain.brokenAtId} on as unverified.</>
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
                Each column is one hex digit, read top to bottom as 8, 4, 2, 1. Keep this hash: if any row is later rewritten, the head no longer matches it.
              </p>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="rows-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="rows-title" className="label-mono text-ink">
              Fig. 02 — This event&rsquo;s rows, newest first
            </h2>
            <p className="flex items-center gap-4 text-12 text-ink-3" aria-hidden>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 bg-ink" /> a change
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block size-2 border-[1.5px] border-ink-3" /> a refused request
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-3 border-l-2 border-dotted border-edge" /> rows outside this event
              </span>
            </p>
          </div>
          <ol className="rounded-sm border border-rule bg-surface px-3 sm:px-5">
            <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
              <Rail up={null} down={isHead ? "solid" : "dashed"} node={isHead ? "head" : "more"} />
              <p className="py-3 text-13 text-ink-2">
                {isHead ? (
                  <>
                    <span className="label-mono mr-2 text-ink">Head</span>This event&rsquo;s latest row is the newest row of the whole log.
                  </>
                ) : (
                  <>The log goes on past this event&rsquo;s latest row: newer rows belong to other events or to the portal.</>
                )}
              </p>
            </li>
            {lines.map((l, i) => {
              const older = lines[i + 1];
              const gap = older ? between(l.id, older.id) : null;
              const broken = brokenFrom !== null && l.id >= brokenFrom;
              const last = i === lines.length - 1;
              return [
                <li key={l.id} className={`grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4 ${refusal(l) ? "text-ink-2" : ""}`}>
                  <Rail up={i === 0 && !isHead ? "dashed" : "solid"} down={last && !reachesGenesis && !olderHidden ? null : "solid"} node={refusal(l) ? "refusal" : "row"} broken={broken} />
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
                </li>,
                gap ? (
                  <li key={`gap-${l.id}`} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
                    <Rail up="dashed" down="dashed" node="gap" />
                    <p className="py-2 font-mono text-12 text-ink-3">{gap}: outside this event; the chain runs through {gap.includes(" to ") ? "them" : "it"}</p>
                  </li>
                ) : null,
              ];
            })}
            {reachesGenesis ? (
              <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4">
                <Rail up="solid" down={null} node="genesis" />
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
