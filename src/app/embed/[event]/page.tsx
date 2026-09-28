import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { PageMark } from "@/components/page-mark";
import { competitionPlaces, ordinal } from "@/lib/places";
import { getGallery, getPublishedResults, NotFoundError, type Gallery } from "@/server/dal";
import { ReportHeight } from "./height";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Projects", robots: { index: false } };

// The embeddable gallery: the event's submitted projects without the portal's
// chrome, for an iframe on the organizers' own site (public/embed.js makes one).
// Links open the full project page in a new tab. Other pages refuse to be framed.
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ event: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { event: key } = await params;
  const { track } = await searchParams;
  let g: Gallery;
  try {
    g = getGallery(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const origin = process.env.PUBLIC_URL ?? "";
  const projects = typeof track === "string" && track ? g.projects.filter((p) => p.trackId === track || p.trackName === track) : g.projects;
  // A frame showing one track names it, so a visitor on the host site knows why only some projects are here.
  const shownTrack = typeof track === "string" && track ? (g.tracks.find((t) => t.id === track || t.name === track) ?? null) : null;
  // Once the results are out, the places from the published run, as the results page counts them: each track's
  // first place (a frame showing one track: its first three), so the winners stand out without a wall of badges.
  const results = g.event.resultsPublishedAt ? getPublishedResults(g.event.id) : null;
  const places = new Map<string, string>();
  if (results?.published) {
    const upTo = shownTrack ? 3 : 1;
    for (const t of results.tracks) {
      competitionPlaces(t.rows).forEach(({ place, joint }, i) => {
        if (place !== null && place <= upTo) places.set(t.rows[i]!.projectId, `${joint ? "Joint " : ""}${ordinal(place)} in ${t.name}`);
      });
    }
  }
  // Bold: once the results are out, the placed projects lead the frame, lit as the portal lights a tile it points at.
  const shown = places.size ? [...projects.filter((p) => places.has(p.id)), ...projects.filter((p) => !places.has(p.id))] : projects;
  return (
    <div className="public min-h-0 p-4 wrap-anywhere">
      <ReportHeight />
      <div className="flex items-stretch gap-6">
        <p className="label-mono flex min-w-0 flex-wrap items-center gap-y-1 text-ink-2">
          <span className="mr-3 inline-block size-2 shrink-0 bg-accent" aria-hidden />
          {g.event.name}
          <span className="mx-3 text-ink-3" aria-hidden>
            /
          </span>
          {shownTrack && (
            <>
              <span className="text-ink">{shownTrack.name}</span>
              <span className="mx-3 text-ink-3" aria-hidden>
                /
              </span>
            </>
          )}
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </p>
        {/* the page's mark, as on the portal's own status strip */}
        <div className="@container relative ml-auto max-w-[160px] min-w-0 flex-1 overflow-hidden" aria-hidden="true">
          <PageMark anchor="right" cols={40} rows={4} className="absolute top-0 right-0 hidden @min-[160px]:block" />
          <PageMark anchor="right" cols={20} rows={4} className="absolute top-0 right-0 @min-[160px]:hidden" />
        </div>
      </div>
      {/* Frames are narrow: under 480 px each project is a row (a small face beside its title), so a phone-sized frame
          shows six projects, not two; wider, a grid of tiles at least 200 px wide (four across a 900 px frame). */}
      <ul className="mt-4 grid grid-cols-1 gap-2 min-[480px]:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] min-[480px]:gap-4">
        {shown.map((p) => (
          <li key={p.id} className="flex">
            <a
              href={`${origin}/events/${g.event.slug}/projects/${p.id}`}
              target="_blank"
              rel="noopener"
              className={`tile ${places.has(p.id) ? "lit" : ""} relative flex w-full flex-row rounded-xs border border-rule bg-surface hover:border-edge min-[480px]:flex-col`}
            >
              <span className="relative flex w-[112px] shrink-0 items-end overflow-hidden rounded-l-xs bg-face-bg min-[480px]:block min-[480px]:w-full min-[480px]:rounded-l-none min-[480px]:rounded-t-xs">
                <Face id={p.id} className="block w-full min-[480px]:hidden" cols={28} rows={16} />
                <Face id={p.id} className="hidden aspect-[16/9] w-full min-[480px]:block" />
                <span className="absolute left-2 top-2 hidden rounded-xs bg-surface px-1.5 py-0.5 font-mono text-12 text-ink-2 min-[480px]:block">{p.id}</span>
              </span>
              <span className="crop-marks" aria-hidden="true" />
              <span className="flex min-w-0 flex-col justify-center px-3 py-2 min-[480px]:block min-[480px]:p-3">
                {places.has(p.id) && (
                  <span className="mb-1 inline-block self-start rounded-xs bg-accent-tint px-1.5 py-0.5 font-mono text-12 text-accent-ink">
                    {places.get(p.id)}
                  </span>
                )}
                <span className="block font-display text-15 leading-5 min-[480px]:text-17 min-[480px]:leading-6">{p.title}</span>
                <span className="mt-0.5 block text-13 text-ink-2 min-[480px]:mt-1">
                  {p.teamName} · {p.trackName}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      {/* the way on: the whole gallery on the portal, in a new tab (the frame's links never navigate the host page) */}
      <p className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t border-rule pt-3 text-13">
        <span className="flex flex-wrap gap-x-6 gap-y-1">
          <a
            href={`${origin}/events/${g.event.slug}`}
            target="_blank"
            rel="noopener"
            className="font-medium text-ink underline decoration-edge underline-offset-4 hover:decoration-accent"
          >
            {shownTrack ? `Every track of ${g.event.name}` : `All of ${g.event.name}`}, on its portal
            <span aria-hidden="true"> ↗</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          {results?.published && (
            <a
              href={`${origin}/events/${g.event.slug}/results`}
              target="_blank"
              rel="noopener"
              className="font-medium text-ink underline decoration-edge underline-offset-4 hover:decoration-accent"
            >
              The results and how they were worked out
              <span aria-hidden="true"> ↗</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
        </span>
        <span className="label-mono text-ink-3">Projects open in a new tab</span>
      </p>
    </div>
  );
}
