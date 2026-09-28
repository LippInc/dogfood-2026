"use client";

import Link from "next/link";
import { Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { plural } from "@/lib/format";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type BrowserItem = {
  id: string;
  title: string;
  summary: string;
  teamName: string;
  trackId: string;
  trackName: string;
  tags: string[];
};
export type BrowserTrack = { id: string; name: string; count: number };
type Order = "shuffled" | "az" | "track";

const GRID = "grid gap-x-6 gap-y-6 sm:grid-cols-2 sm:gap-y-10 lg:grid-cols-3 xl:grid-cols-4";
const two = (n: number) => String(n).padStart(2, "0");

const ORDER_HINT: Record<Order, string> = {
  shuffled: "new order each visit, so no project is always first",
  az: "by title",
  track: "grouped by track, then by title",
};

function matches(item: BrowserItem, q: string): boolean {
  if (!q) return true;
  const hay = `${item.title} ${item.teamName} ${item.trackName} ${item.id} ${item.tags.join(" ")}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

/** Marks every part of `text` a search word matched, so a result shows why it is there. */
function Hl({ text, words }: { text: string; words: string[] }) {
  const lower = text.toLowerCase();
  if (!words.length || lower.length !== text.length) return <>{text}</>;
  const on = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let at = lower.indexOf(w); at !== -1; at = lower.indexOf(w, at + 1)) on.fill(true, at, at + w.length);
  }
  const parts: ReactNode[] = [];
  for (let i = 0; i < text.length; ) {
    const start = i;
    while (i < text.length && on[i] === on[start]) i++;
    const s = text.slice(start, i);
    parts.push(
      on[start] ? (
        <mark key={start} className="rounded-xs bg-accent-tint text-ink shadow-[inset_0_-2px_0_var(--accent)]">
          {s}
        </mark>
      ) : (
        s
      ),
    );
  }
  return <>{parts}</>;
}

/**
 * The Field (FIG. 01) plus the project grid. Every project is in the server's HTML
 * on first paint (the organizers' checker reads it); choosing a track or typing a
 * search only narrows what is shown.
 */
export function GalleryBrowser({
  eventSlug,
  items,
  tracks,
  tileFaces,
  smallFaces,
  initialTrack,
  initialQuery,
  mine = null,
}: {
  eventSlug: string;
  items: BrowserItem[];
  tracks: BrowserTrack[];
  tileFaces: Record<string, ReactNode>;
  smallFaces: Record<string, ReactNode>;
  initialTrack: string | null;
  initialQuery: string;
  /** The signed-in participant's own project, marked in the Field and the grid. */
  mine?: string | null;
}) {
  const [track, setTrackState] = useState<string | null>(
    initialTrack && tracks.some((t) => t.id === initialTrack) ? initialTrack : null,
  );
  const [query, setQueryState] = useState(initialQuery);
  const [order, setOrder] = useState<Order>("shuffled");
  // The face under the pointer in the Field: named in the Field's caption and lit in the grid.
  const [peek, setPeek] = useState<string | null>(null);
  const peeked = peek ? items.find((i) => i.id === peek) : undefined;
  const ours = mine ? items.find((i) => i.id === mine) : undefined;

  // Phones: the chosen track's chip may sit far along the chip row (chosen by its link, ?track=, or by a
  // tap on the Field's picture); bring it into view whenever the track changes.
  const chipRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = chipRow.current;
    const chosen = row?.querySelector<HTMLElement>('[data-track][aria-pressed="true"]');
    if (row && chosen) row.scrollLeft = chosen.offsetLeft - row.offsetLeft - (row.clientWidth - chosen.offsetWidth) / 2;
  }, [track]);

  const syncUrl = (nextTrack: string | null, nextQuery: string) => {
    const url = new URL(window.location.href);
    if (nextTrack) url.searchParams.set("track", nextTrack);
    else url.searchParams.delete("track");
    if (nextQuery) url.searchParams.set("q", nextQuery);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  };
  const setTrack = (t: string | null) => {
    setTrackState(t);
    syncUrl(t, query);
  };
  const setQuery = (q: string) => {
    setQueryState(q);
    syncUrl(track, q);
  };

  const visible = useMemo(() => {
    const list = items.filter((i) => (!track || i.trackId === track) && matches(i, query.trim()));
    if (order === "az") return [...list].sort((a, b) => a.title.localeCompare(b.title));
    if (order === "track") {
      const pos = new Map(tracks.map((t, i) => [t.id, i]));
      return [...list].sort((a, b) => pos.get(a.trackId)! - pos.get(b.trackId)! || a.title.localeCompare(b.title));
    }
    return list;
  }, [items, tracks, track, query, order]);
  // The Field draws what the grid shows: faces the grid has left out fade back.
  const shown = useMemo(() => new Set(visible.map((i) => i.id)), [visible]);
  const q = query.trim();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (text: string) => words.some((w) => text.toLowerCase().includes(w));
  const matchesIn = (trackId: string) => items.filter((i) => i.trackId === trackId && matches(i, q)).length;
  const elsewhere = q ? items.filter((i) => matches(i, q)).length : 0;
  const trackName = track ? tracks.find((t) => t.id === track)?.name : undefined;

  const tile = (i: BrowserItem) => (
    <li key={i.id} className="border-b border-rule pb-6 last:border-b-0 sm:border-0 sm:pb-0">
      <Link
        href={`/events/${eventSlug}/projects/${i.id}`}
        onMouseEnter={() => setPeek(i.id)}
        onMouseLeave={() => setPeek(null)}
        onFocus={() => setPeek(i.id)}
        onBlur={() => setPeek(null)}
        className={`tile flex gap-4 sm:block ${peek === i.id ? "lit" : ""}`}
      >
        <div className="relative w-[120px] shrink-0 self-start sm:w-auto">
          <div className="relative overflow-hidden rounded-xs border border-rule">
            {tileFaces[i.id]}
            <span className="absolute left-2.5 top-2.5 hidden rounded-xs bg-surface px-1.5 py-0.5 font-mono text-12 text-ink-2 sm:inline">
              <Hl text={i.id} words={words} />
            </span>
          </div>
          <span className="crop-marks" aria-hidden="true" />
        </div>
        <div className="min-w-0 wrap-anywhere">
          <h3 className="font-display text-20 leading-tight sm:mt-4">
            <Hl text={i.title} words={words} />
          </h3>
          {i.summary ? <p className="mt-1 text-15 text-ink-2">{i.summary}</p> : null}
          <p className="mt-2 text-13 text-ink-3">
            {i.id === mine ? (
              <Badge className="mr-2 border-ink align-[1px] text-ink">Your team</Badge>
            ) : null}
            <Hl text={i.teamName} words={words} /> · <Hl text={i.trackName} words={words} />
          </p>
          {i.tags.length ? (
            <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Tech tags">
              {/* A tag the search matched comes first, so it is never hidden behind "+n". */}
              {[...i.tags]
                .sort((x, y) => Number(hits(y)) - Number(hits(x)))
                .slice(0, 4)
                .map((t) => (
                  <li key={t} className="rounded-xs border border-rule px-1.5 py-0.5 font-mono text-12 text-ink-2">
                    <Hl text={t} words={words} />
                  </li>
                ))}
              {i.tags.length > 4 ? <li className="px-1 py-0.5 text-12 text-ink-3">+{i.tags.length - 4}</li> : null}
            </ul>
          ) : null}
        </div>
      </Link>
    </li>
  );

  const chip =
    "inline-flex h-11 shrink-0 items-center gap-2 rounded-sm border px-4 text-15 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent";

  return (
    <>
      {/* FIG. 01: the whole event at a glance; also the track filter. */}
      <section aria-labelledby="field-title" className="hidden border-t border-rule pt-6 md:block">
        <div className="flex items-center gap-5">
          <h2 id="field-title" className="label-mono text-ink">
            Fig. 01 — The field
          </h2>
          <p className="min-w-0 truncate text-13 text-ink-3">
            {peeked ? (
              <>
                <span className="font-mono text-12 text-accent-ink">{peeked.id}</span> <span className="font-semibold text-ink">{peeked.title}</span> by{" "}
                {peeked.teamName}
              </>
            ) : q || track ? (
              <>
                <span className="tnum font-semibold text-ink">
                  {visible.length} of {items.length}
                </span>{" "}
                {q ? <>match “{q}”{trackName ? ` in ${trackName}` : ""}</> : <>in {trackName}</>}. The rest fade back.
              </>
            ) : (
              <>
                Every project, by track, each face a pattern drawn from its id. Choose a track to filter.
                {ours ? (
                  <>
                    {" "}
                    Your team’s,{" "}
                    <Link
                      href={`/events/${eventSlug}/projects/${ours.id}`}
                      className="font-semibold text-ink underline decoration-edge underline-offset-2 hover:decoration-ink"
                    >
                      {ours.title}
                    </Link>
                    , has the pink corners.
                  </>
                ) : null}
              </>
            )}
          </p>
          <button
            type="button"
            aria-pressed={track === null}
            onClick={() => setTrack(null)}
            className="ml-auto h-7 rounded-xs border border-edge px-3 text-13 font-medium aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent"
          >
            All <span className="tnum">{q ? `${elsewhere} of ${items.length}` : items.length}</span>
          </button>
        </div>
        <div className="mt-6 grid grid-cols-4 gap-x-4 gap-y-8 xl:grid-cols-8">
          {tracks.map((t, ti) => {
            const inTrack = items.filter((i) => i.trackId === t.id);
            const lit = track === t.id;
            return (
              <div key={t.id} className={lit ? "lit" : undefined}>
                <button
                  type="button"
                  aria-pressed={lit}
                  onClick={() => setTrack(lit ? null : t.id)}
                  className="group flex w-full items-baseline gap-1.5 border-t-2 border-ink pt-2 text-left text-13 text-ink-2 hover:text-ink aria-pressed:border-accent aria-pressed:text-ink"
                >
                  <span className="truncate">{t.name}</span>
                  <span className="tnum text-ink-3">{q ? `${matchesIn(t.id)} of ${t.count}` : t.count}</span>
                </button>
                <div className="mt-3 grid grid-cols-2 gap-1" aria-hidden="true" onMouseLeave={() => setPeek(null)}>
                  {inTrack.map((i, k) => (
                    // A pointer shortcut to the project; keyboard and screen readers use the grid's links.
                    <Link
                      key={i.id}
                      href={`/events/${eventSlug}/projects/${i.id}`}
                      tabIndex={-1}
                      title={i.title}
                      onMouseEnter={() => setPeek(i.id)}
                      className={`develop block ${peek === i.id ? "lit" : ""} ${i.id === mine ? "own-marks" : ""}`}
                      style={{ "--i": ti * 2 + k } as CSSProperties}
                    >
                      <div
                        className={`transition-opacity duration-150 motion-reduce:transition-none ${shown.has(i.id) ? "" : "opacity-30"}`}
                      >
                        {smallFaces[i.id]}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Phones: the Field shrinks to a picture (one column per track, no labels); a tap on a column chooses its
          track, a pointer shortcut like the faces above, while the chips below stay the controls for keyboards and screen readers. */}
      <div className="border-t border-rule pt-4 md:hidden" aria-hidden="true">
        <p className="label-mono flex justify-between text-ink">
          <span>Fig. 01 — The field</span>
          <span className="tnum text-ink-3">
            {visible.length === items.length ? items.length : `${visible.length} of ${items.length}`}
          </span>
        </p>
        <div className="mt-3 grid grid-cols-8 gap-1">
          {tracks.map((t) => (
            <div
              key={t.id}
              onClick={() => setTrack(track === t.id ? null : t.id)}
              className={`flex cursor-pointer flex-col gap-1 border-t-2 pt-1 ${track === t.id ? "lit border-accent" : "border-ink"}`}
            >
              {items
                .filter((i) => i.trackId === t.id)
                .map((i) => (
                  <div
                    key={i.id}
                    className={`transition-opacity duration-150 motion-reduce:transition-none ${shown.has(i.id) ? "" : "opacity-30"} ${
                      i.id === mine ? "own-marks" : ""
                    }`}
                  >
                    {smallFaces[i.id]}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </div>

      {/* Phones: the mosaic's filter becomes scrolling track chips (44px targets); the row's right edge fades,
          so chips beyond the edge read as more to scroll to (a low-vision tester at 200 % zoom saw no sign of them). */}
      <div
        ref={chipRow}
        className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 pb-1 [mask-image:linear-gradient(to_right,#000_calc(100%_-_32px),transparent)] md:hidden"
        role="group"
        aria-label="Filter by track"
      >
        <button type="button" aria-pressed={track === null} onClick={() => setTrack(null)} className={`${chip} border-edge`}>
          All <span className="tnum">{q ? `${elsewhere} of ${items.length}` : items.length}</span>
        </button>
        {tracks.map((t) => (
          <button
            key={t.id}
            type="button"
            data-track={t.id}
            aria-pressed={track === t.id}
            onClick={() => setTrack(track === t.id ? null : t.id)}
            className={`${chip} border-edge`}
          >
            {t.name} <span className="tnum">{q ? `${matchesIn(t.id)} of ${t.count}` : t.count}</span>
          </button>
        ))}
      </div>

      <div className="mt-6 flex flex-col gap-4 border-rule md:mt-10 md:flex-row md:items-center md:gap-6 md:border-t md:pt-6">
        <div className="relative w-full md:max-w-[380px]">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects, teams, tracks"
            aria-label="Search projects, teams and tracks"
            className="h-11 w-full rounded-sm border border-edge bg-surface pl-10 pr-10 text-15 placeholder:text-ink-3 md:h-10"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-sm text-ink-3 hover:text-ink"
              aria-label="Clear search"
            >
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-4 md:contents">
          <label className="flex items-center gap-2 text-14 text-ink-2">
            Order
            <select
              value={order}
              onChange={(e) => setOrder(e.target.value as Order)}
              className="h-9 cursor-pointer rounded-sm bg-transparent pr-1 text-14 font-semibold text-ink"
            >
              <option value="shuffled">Shuffled</option>
              <option value="az">A to Z</option>
              <option value="track">By track</option>
            </select>
          </label>
          <span className="hidden text-13 text-ink-3 lg:inline">{ORDER_HINT[order]}</span>
          <span className="label-mono tnum text-ink-3 md:ml-auto" aria-live="polite">
            {visible.length === items.length ? `${visible.length} shown` : `${visible.length} of ${items.length} shown`}
          </span>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="mt-10 rounded-sm border border-dashed border-edge px-6 py-12 text-center">
          <p className="text-17">No projects yet.</p>
          <p className="mt-2 text-14 text-ink-2">Submitted projects appear here, in a new order for each visit.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-10 rounded-sm border border-dashed border-edge px-6 py-12 text-center">
          <p className="text-17">
            No project matches {q ? `“${q}”` : "this filter"}
            {trackName ? ` in ${trackName}` : ""}.
          </p>
          <p className="mt-2 text-14 text-ink-2">Search reads titles, teams, tracks, ids and tags, and every word has to match.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {track && q && elsewhere > 0 ? (
              <button
                type="button"
                onClick={() => setTrack(null)}
                className="h-10 rounded-sm border border-accent bg-accent px-4 text-14 font-medium text-on-accent"
              >
                Search every track ({elsewhere})
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setTrackState(null);
                setQuery("");
              }}
              className="h-10 rounded-sm border border-edge px-4 text-14 hover:bg-surface"
            >
              Show all {items.length} projects
            </button>
          </div>
        </div>
      ) : order === "track" ? (
        // By track: each track's projects under its own heading, numbered like the results page.
        <div className="mt-8 flex flex-col gap-12 md:mt-10">
          {tracks.map((t, ti) => {
            const list = visible.filter((i) => i.trackId === t.id);
            if (!list.length) return null;
            return (
              <section key={t.id} aria-labelledby={`grid-track-${t.id}`}>
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-2 border-ink pb-2">
                  <span className="label-mono tnum text-ink-3">
                    Track {two(ti + 1)} / {two(tracks.length)}
                  </span>
                  <h2 id={`grid-track-${t.id}`} className="text-24 font-semibold wrap-anywhere">
                    <Hl text={t.name} words={words} />
                  </h2>
                  <span className="label-mono tnum ml-auto text-ink-3">
                    {list.length === t.count ? plural(t.count, "project") : `${list.length} of ${t.count}`}
                  </span>
                </div>
                <ul className={`${GRID} mt-6`}>{list.map(tile)}</ul>
              </section>
            );
          })}
        </div>
      ) : (
        <ul className={`${GRID} mt-6 md:mt-8`}>{visible.map(tile)}</ul>
      )}
    </>
  );
}
