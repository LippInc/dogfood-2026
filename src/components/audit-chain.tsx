import { HashGlyph, hashGroups } from "@/components/figures/hash-glyph";
import { plural } from "@/lib/format";
import type { AuditLine } from "@/server/dal";

// The audit log drawn as what it is: one hash chain for the whole portal. The seal says
// whether the chain holds and draws the head hash as its 256 bits; each row is a node on
// one line, a change filled and a refused request hollow, with the line dotted through
// rows that belong elsewhere. The drawing matches the event's Audit log tab; the portal
// log (/organize/log) uses these pieces.

export type Chain = { ok: true; rows: number; head: string } | { ok: false; brokenAtId: number; missing?: number };

/** The seal's heading: verified, broken at a row, or rows missing (src/server/audit.ts verifyAuditChain). */
export function chainHeading(chain: Chain): string {
  if (chain.ok) return "Chain verified";
  return chain.missing ? `${plural(chain.missing, "row")} missing from the chain` : `Chain broken at row #${chain.brokenAtId}`;
}

/**
 * The rows strictly between two shown rows that are missing from the log (a broken chain's `missing` rows), in words,
 * or null: a gap row says so instead of "the chain runs through them".
 */
export function missingIn(chain: Chain, newer: number, older: number): string | null {
  if (chain.ok || !chain.missing) return null;
  const from = Math.max(older + 1, chain.brokenAtId);
  const to = Math.min(newer - 1, chain.brokenAtId + chain.missing - 1);
  if (from > to) return null;
  return from === to ? `#${from} is missing from the log (Fig. 01)` : `#${from} to #${to} are missing from the log (Fig. 01)`;
}

/**
 * How to keep the head as an anchor. A chain that verifies has ids 1 to its row count with none skipped, so the head
 * is row #rows: the same entry and hash pair audit.csv carries on every line and a signed record pins.
 */
export function keepHeadText(rows: number, check: "below" | "event" = "event"): string {
  const where = check === "below" ? "with the form below" : "on an event’s Audit log page";
  return `Each column is one hex digit, read top to bottom as 8, 4, 2, 1. Keep this hash with its row, #${rows}: while the log still holds row #${rows} with this hash and the chain recomputes whole up to it, nothing up to it was rewritten or cut. audit.csv carries the same pair on every line. Check a pair you saved ${where}, or at GET /api/events/{event}/audit/anchor.`;
}

/** What a broken chain means, in words. */
export function chainBrokenText(chain: Extract<Chain, { ok: false }>): string {
  if (!chain.missing) return `A row was changed outside the app. Treat everything from row #${chain.brokenAtId} on as unverified.`;
  const first = chain.brokenAtId;
  const which = chain.missing === 1 ? `Row #${first} is` : `Rows #${first} to #${first + chain.missing - 1} are`;
  return `${which} not in the log, though SQLite gave out ${chain.missing === 1 ? "its id" : "their ids"}: removed outside the app, or written past by a tool. Treat everything from row #${first} on as unverified.`;
}

export const isRefusal = (l: AuditLine) => l.action.endsWith(".refused");

/** "#2" or "#12 to #15": the rows strictly between two shown rows, or null when they touch. */
export function between(newer: number, older: number): string | null {
  if (newer - older <= 1) return null;
  return newer - older === 2 ? `#${older + 1}` : `#${older + 1} to #${newer - 1}`;
}

/** A row's sentence: names bold, identifiers mono, as the data layer split it. */
export function AuditSentence({ l }: { l: AuditLine }) {
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

export type RailLine = "solid" | "dashed" | null;
export type RailNode = "row" | "refusal" | "head" | "genesis" | "gap" | "more";

/** The rail: the chain's line through this row, with the row's node on it. Decorative. */
export function ChainRail({ up, down, node, broken }: { up: RailLine; down: RailLine; node: RailNode; broken?: boolean }) {
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

/** The legend for the rows figure. Decorative: every row also says what it is in words. */
export function ChainLegend({ outside }: { outside: string }) {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-12 text-ink-3" aria-hidden>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2 bg-ink" /> a change
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2 border-[1.5px] border-ink-3" /> a refused request
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-3 border-l-2 border-dotted border-edge" /> {outside}
      </span>
    </p>
  );
}

/** Fig. 01: whether the whole log's chain holds, in words, and its head hash drawn as its 256 bits. */
export function ChainSeal({ chain }: { chain: Chain }) {
  return (
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
            <>Recomputed from the first row on this request: {plural(chain.rows, "row")} in the whole log, each hash matching the row before it.</>
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
            {keepHeadText(chain.rows)}
          </p>
        </div>
      ) : null}
    </section>
  );
}
