import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
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
  return (
    <div className="public min-h-0 p-4 wrap-anywhere">
      <ReportHeight />
      <p className="label-mono text-ink-3">
        {g.event.name} · {projects.length} {projects.length === 1 ? "project" : "projects"}
      </p>
      <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
        {projects.map((p) => (
          <li key={p.id}>
            <a
              href={`${origin}/events/${g.event.slug}/projects/${p.id}`}
              target="_blank"
              rel="noopener"
              className="tile block rounded-xs border border-rule bg-surface hover:border-edge"
            >
              <Face id={p.id} className="block aspect-[16/9] w-full" />
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
