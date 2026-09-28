import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { PageMark } from "@/components/page-mark";
import { getGallery, NotFoundError, type Gallery } from "@/server/dal";
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
      <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {projects.map((p) => (
          <li key={p.id} className="flex">
            <a
              href={`${origin}/events/${g.event.slug}/projects/${p.id}`}
              target="_blank"
              rel="noopener"
              className="tile relative flex w-full flex-col rounded-xs border border-rule bg-surface hover:border-edge"
            >
              <span className="relative block overflow-hidden rounded-t-xs">
                <Face id={p.id} className="block aspect-[16/9] w-full" />
                <span className="absolute left-2 top-2 rounded-xs bg-surface px-1.5 py-0.5 font-mono text-12 text-ink-2">{p.id}</span>
              </span>
              <span className="crop-marks" aria-hidden="true" />
              <span className="block p-3">
                <span className="block font-display text-17 leading-6">{p.title}</span>
                <span className="mt-1 block text-13 text-ink-2">
                  {p.teamName} · {p.trackName}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-12 text-ink-3">
        <a href={`${origin}/events/${g.event.slug}`} target="_blank" rel="noopener" className="underline underline-offset-2">
          All of {g.event.name}
        </a>
      </p>
    </div>
  );
}
