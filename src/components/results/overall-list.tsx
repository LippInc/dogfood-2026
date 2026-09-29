import type { CSSProperties } from "react";
import Link from "next/link";
import { Face } from "@/components/face";
import { movesByProject, RowChangeMarks, TieBreakChangesNotice, tieBrokenByOf, TrackMovesNotice, WeightChangesNotice } from "@/components/results/after-the-fact";
import { ScaleAxis, ScoreLine, scaleFor } from "@/components/results/score-line";
import { formatUtc, plural } from "@/lib/format";
import { overallOrder } from "@/lib/overall";
import { ordinal } from "@/lib/places";
import type { PublishedResults } from "@/server/dal";

// The public overall order (/events/[event]/results/overall): every ranked project in one list by
// the published run's rankOverall, each with its track and its place there as the per-track page
// shows it. Hidden exactly when the per-track results are. In pairwise mode it says why no overall
// order applies instead. Server-rendered from getPublishedResults, the per-track page's own read,
// in that page's rows, figure and words; nothing here is new data.

// The per-track page's row grid with one more column on a wide screen for the track and its place;
// narrower, the track goes under the team, as the per-track rows keep everything but the figure in one line.
const ROW =
  "grid grid-cols-[56px_minmax(0,1fr)_auto] gap-x-4 md:grid-cols-[72px_64px_minmax(0,1fr)_minmax(160px,280px)_112px] lg:grid-cols-[72px_64px_minmax(180px,1fr)_minmax(150px,220px)_minmax(240px,440px)_120px]";

const fmtScore = (v: number | null) => (v === null ? "–" : v.toFixed(2));
const fmtSe = (v: number | null) => (v === null ? "" : `± ${v.toFixed(2)}`);
const fmtN = (n: number) => `${n} ${n === 1 ? "review" : "reviews"}`;

export function OverallResults({
  results,
  pairwise,
  eventSlug,
  counts,
}: {
  results: PublishedResults;
  pairwise: boolean;
  eventSlug: string;
  counts: { projects: number; tracks: number };
}) {
  const perTrack = `/events/${eventSlug}/results`;
  const back = (
    <Link href={perTrack} className="underline underline-offset-4 hover:text-accent-ink">
      Places per track
    </Link>
  );
  const title = <h1 className="font-display text-[48px] leading-[52px] md:text-64">Overall order</h1>;

  if (!results.published) {
    return (
      <>
        <div className="pt-10">{title}</div>
        <section className="mt-10 max-w-[760px] border-t border-rule pt-8" aria-labelledby="hidden-title">
          <p className="label-mono text-accent-ink">Not yet published</p>
          <h2 id="hidden-title" className="mt-3 text-24 font-semibold">
            The results are hidden until the organizers publish them
          </h2>
          <p className="mt-3 text-17 text-ink-2">
            Judging covers {plural(counts.projects, "project")} in {plural(counts.tracks, "track")}. When the organizers publish, this page lists every
            ranked project in one order by score, next to its place in its own track.
          </p>
        </section>
      </>
    );
  }

  if (pairwise) {
    return (
      <>
        <div className="pt-10">
          {title}
          <p className="label-mono mt-3 tnum text-ink-3">
            Published {formatUtc(results.publishedAt)} · {back}
          </p>
        </div>
        <section className="mt-10 max-w-[760px] border-t border-rule pt-8" aria-labelledby="no-overall-title">
          <p className="label-mono text-accent-ink">No overall order for this event</p>
          <h2 id="no-overall-title" className="mt-3 text-24 font-semibold">
            A win % compares only within its own track
          </h2>
          <p className="mt-3 text-17 text-ink-2">
            The judges compared projects two at a time within a track, and each project&rsquo;s win % is its chance to beat an average project of that
            track. A win % in one track and one in another are measured against different projects, so one list across tracks would show an order the
            judging never measured. The places are on the results page, track by track.
          </p>
          <p className="mt-4">
            <Link href={perTrack} className="text-15 font-semibold text-ink underline underline-offset-4 hover:text-accent-ink">
              See the places per track
            </Link>
          </p>
        </section>
      </>
    );
  }

  const entries = overallOrder(results.tracks);
  const rows = results.tracks.flatMap((t) => t.rows);
  // the per-track page's scale over the same rows, so a bar sits where it sits there
  const scale = scaleFor(
    rows.flatMap((r) => (r.score === null ? [] : [r.score - (r.se ?? 0), r.score + (r.se ?? 0), ...(r.raw !== null ? [r.raw] : [])])),
    false,
  );
  const trackCount = new Set(entries.map((e) => e.track.id)).size;
  // what the organizers changed after the fact, disclosed as on the per-track page: the moves the published run recorded, per project
  const movesOf = movesByProject(results.trackMoves);
  const movedCount = entries.filter((e) => movesOf.has(e.row.projectId)).length;

  return (
    <>
      <div className="pt-10">
        {title}
        <p className="label-mono mt-3 tnum text-ink-3">
          Published {formatUtc(results.publishedAt)} · {plural(entries.length, "project")} across {plural(trackCount, "track")} · {back}
        </p>
        <p className="mt-6 max-w-[760px] border-y border-rule py-3 text-17 text-ink">
          Places and prizes are decided within each track. This list puts every project in one order by score, for reading across tracks; tracks meet
          only through judges who scored in both, so read it loosely.
        </p>
        <WeightChangesNotice changes={results.weightChanges} className="mt-6" />
        <TieBreakChangesNotice changes={results.tieBreakChanges} className="mt-6" />
        <TrackMovesNotice count={movedCount} className="mt-6" />
      </div>

      <section aria-labelledby="overall-title" className="mt-12 pb-16">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2 border-t border-rule pt-6">
          <h2 id="overall-title" className="label-mono text-ink">
            Every project, one order
          </h2>
          <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-13 text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-full bg-ink" aria-hidden /> the published score
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="relative inline-block h-2 w-5 border-x border-ink-3" aria-hidden>
                <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-3" />
              </span>
              ± one standard error
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-3.5 rounded-full border-[1.5px] border-ink-2" aria-hidden /> the plain average of every review, before leniency
            </span>
            <span>Where two bars overlap, read the order as a tie.</span>
          </p>
        </div>
        <div className={`${ROW} mt-8 items-end border-b-2 border-ink pb-2`} aria-hidden="true">
          <span className="label-mono row-start-1 text-ink-3 max-md:hidden md:col-start-1">Order</span>
          <span className="label-mono row-start-1 text-ink-3 max-md:hidden md:col-start-3">Project</span>
          <span className="label-mono row-start-1 text-ink-3 max-lg:hidden lg:col-start-4">Track · place in it</span>
          <span className="col-span-2 col-start-2 row-start-1 max-md:pr-3 md:col-span-1 md:col-start-4 lg:col-start-5">
            <ScaleAxis scale={scale} />
          </span>
          <span className="label-mono row-start-1 text-right text-ink-3 max-md:hidden md:col-start-5 lg:col-start-6">Score</span>
        </div>
        <ol className="divide-y divide-rule">
          {entries.map((e, i) => {
            const r = e.row;
            const first = e.trackPlace.place === 1;
            const trackPlace = `${ordinal(e.trackPlace.place)}${e.trackPlace.joint ? ", joint" : ""} in ${e.track.name}`;
            return (
              <li key={r.projectId} className={`reveal tile ${ROW} items-center gap-y-2 py-3 ${first ? "lit" : ""}`} style={{ "--i": i } as CSSProperties}>
                <span className="font-display text-24 tnum">
                  {e.position}
                  {e.joint ? <span className="ml-1 align-top font-sans text-12 text-ink-2">joint</span> : null}
                </span>
                <span className="max-md:hidden">
                  <Face id={r.projectId} cols={32} rows={18} className="block h-9 w-16" />
                </span>
                <span className="min-w-0">
                  <Link href={`/events/${eventSlug}/projects/${r.projectId}`} className="block truncate text-17 font-semibold hover:underline">
                    {r.title}
                  </Link>
                  <span className="block truncate text-14 text-ink-2">{r.teamName}</span>
                  {/* narrower than a wide screen, the track and its place under the team */}
                  <span className={`block truncate text-14 lg:hidden ${first ? "font-semibold text-accent-ink" : "text-ink-2"}`}>{trackPlace}</span>
                  <RowChangeMarks
                    projectHref={`/events/${eventSlug}/projects/${r.projectId}`}
                    teamChangedAt={r.teamChangedAt}
                    tieBrokenBy={tieBrokenByOf(r, results.tieBreak)}
                    moves={movesOf.get(r.projectId)}
                  />
                </span>
                <span className="min-w-0 max-lg:hidden lg:col-start-4 lg:row-start-1">
                  <span className="sr-only">{trackPlace}</span>
                  <span className="block truncate text-15" aria-hidden="true">
                    {e.track.name}
                  </span>
                  <span className={`block text-14 tnum ${first ? "font-semibold text-accent-ink" : "text-ink-2"}`} aria-hidden="true">
                    {ordinal(e.trackPlace.place)} in its track{e.trackPlace.joint ? ", joint" : ""}
                  </span>
                </span>
                <span className="col-span-2 col-start-2 row-start-2 max-md:pr-3 md:col-span-1 md:col-start-4 md:row-start-1 lg:col-start-5">
                  <ScoreLine scale={scale} score={r.score} se={r.se} raw={r.raw} first={first} index={i} />
                </span>
                <span className="col-start-3 row-start-1 text-right md:col-start-5 lg:col-start-6">
                  <span className="block text-20 font-semibold tnum">{fmtScore(r.score)}</span>
                  <span className="block text-12 text-ink-2 tnum">
                    {r.se !== null ? `${fmtSe(r.se)} · ` : ""}
                    {fmtN(r.n)}
                  </span>
                  {r.n < 2 ? <span className="block text-12 text-flag">under-reviewed</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </>
  );
}
