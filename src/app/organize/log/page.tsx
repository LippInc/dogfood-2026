import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { AuditSentence, between, ChainLegend, ChainRail, ChainSeal, isRefusal } from "@/components/audit-chain";
import { HashGlyph } from "@/components/figures/hash-glyph";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getPortalLog } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Portal log" };

// The entries no event owns, drawn like an event's Audit log tab: the seal of the whole
// chain, then the portal's rows as nodes on the chain's one line, dotted through the rows
// that belong to events. When every portal row is shown, the line runs on to row #1.

/** "#3" or "#3 to #5 belong to events": the rows between two portal rows. */
const eventRows = (range: string) => `${range} ${range.includes(" to ") ? "belong to events" : "belongs to an event"}; the chain runs through ${range.includes(" to ") ? "them" : "it"}`;

/** The entries no event owns, for the portal's administrators. */
export default async function PortalLogPage() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { lines, total, chain } = guardPage(() => getPortalLog(actor));
  const isHead = chain.ok && lines[0]?.hash === chain.head;
  const allShown = total === lines.length;
  const oldest = lines.at(-1)?.id;
  // The rows older than the portal's oldest row belong to events; the line reaches row #1 through them.
  const belowOldest = allShown && oldest !== undefined && oldest > 1 ? (oldest === 2 ? "#1" : `#1 to #${oldest - 1}`) : null;
  const reachesGenesis = allShown && oldest !== undefined;
  const brokenFrom = chain.ok ? null : chain.brokenAtId;
  const refused = lines.filter(isRefusal).length;
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="Portal log" person={actor.name} role="Administrator">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-mono text-ink-2">Administrator · the whole portal</p>
            <h1 className="mt-1 text-24 font-semibold">Portal log</h1>
            <p className="mt-2 max-w-[760px] text-15 text-ink-2">
              The entries no event owns: accounts made, sign-ins, API tokens, the signing key, demo mode, and requests refused outside any event.
              Each event&rsquo;s own entries are on its Audit log tab. Both are parts of one hash chain.
            </p>
          </div>
          <a href="/api/audit" className="inline-flex h-9 items-center gap-2 rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised">
            Open as JSON <span className="font-mono text-12 text-ink-2">GET /api/audit</span>
          </a>
        </header>

        <ChainSeal chain={chain} />

        <section aria-labelledby="rows-title" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="rows-title" className="label-mono text-ink">
              Fig. 02 — The portal&rsquo;s rows, newest first
            </h2>
            <ChainLegend outside="rows of an event" />
          </div>
          {lines.length === 0 ? (
            <p className="rounded-sm border border-dashed border-edge px-5 py-6 text-14 text-ink-2">
              No entry yet that no event owns. The first account made, API token or refused request outside an event lands here.
            </p>
          ) : (
            <ol className="rounded-sm border border-rule bg-surface px-3 sm:px-5">
              <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
                <ChainRail up={null} down={isHead ? "solid" : "dashed"} node={isHead ? "head" : "more"} />
                <p className="py-3 text-13 text-ink-2">
                  {isHead ? (
                    <>
                      <span className="label-mono mr-2 text-ink">Head</span>The portal&rsquo;s latest row is the newest row of the whole log.
                    </>
                  ) : (
                    <>The log goes on past the portal&rsquo;s latest row: the newer rows belong to events.</>
                  )}
                </p>
              </li>
              {lines.map((l, i) => {
                const older = lines[i + 1];
                const gap = older ? between(l.id, older.id) : null;
                const broken = brokenFrom !== null && l.id >= brokenFrom;
                const last = i === lines.length - 1;
                return [
                  <li key={l.id} className={`grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4 ${isRefusal(l) ? "text-ink-2" : ""}`}>
                    <ChainRail
                      up={i === 0 && !isHead ? "dashed" : "solid"}
                      down={last && belowOldest ? "dashed" : "solid"}
                      node={isRefusal(l) ? "refusal" : "row"}
                      broken={broken}
                    />
                    <div className="grid gap-x-5 gap-y-1 py-3 md:grid-cols-[150px_150px_minmax(0,1fr)_auto]">
                      <p className="flex items-center gap-2.5 font-mono text-12 text-ink-2" title={l.hash}>
                        <HashGlyph hash={l.hash} />
                        <span>
                          <span className="text-ink">#{l.id}</span> {l.hash.slice(0, 8)}
                        </span>
                      </p>
                      <p className="font-mono text-12 whitespace-nowrap text-ink-2 md:pt-px">{formatUtc(l.at).replace(" UTC", "")}</p>
                      <p className="text-14 leading-5 wrap-anywhere">
                        <AuditSentence l={l} />
                        {brokenFrom === l.id ? <span className="ml-2 text-13 font-medium text-flag">The chain breaks here.</span> : null}
                      </p>
                      <p className="font-mono text-12 text-ink-3 md:pt-px md:text-right">{l.action}</p>
                    </div>
                  </li>,
                  gap ? (
                    <li key={`gap-${l.id}`} className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
                      <ChainRail up="dashed" down="dashed" node="gap" />
                      <p className="py-2 font-mono text-12 text-ink-3">{eventRows(gap)}</p>
                    </li>
                  ) : null,
                ];
              })}
              {belowOldest ? (
                <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 sm:gap-x-4">
                  <ChainRail up="dashed" down="dashed" node="gap" />
                  <p className="py-2 font-mono text-12 text-ink-3">{eventRows(belowOldest)}</p>
                </li>
              ) : null}
              {reachesGenesis ? (
                <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4">
                  <ChainRail up={belowOldest ? "dashed" : "solid"} down={null} node="genesis" />
                  <p className="py-3 text-13 text-ink-2">
                    <span className="label-mono mr-2 text-ink">Genesis</span>Row #1 links to a hash of 64 zeros, the chain&rsquo;s fixed start.
                  </p>
                </li>
              ) : (
                <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-x-3 border-t border-rule sm:gap-x-4">
                  <ChainRail up="dashed" down={null} node="more" />
                  <p className="py-3 text-13 text-ink-2">
                    Older portal rows: <code className="font-mono text-12">GET /api/audit?limit=5000</code>.
                  </p>
                </li>
              )}
            </ol>
          )}
        </section>
        <p className="text-13 text-ink-2">
          Showing the latest {lines.length} of {plural(total, "entry", "entries")} that no event owns
          {refused ? <>, {plural(refused, "refused request")} among them</> : null}.
        </p>
      </div>
    </WorkShell>
  );
}
