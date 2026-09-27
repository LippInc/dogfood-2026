import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { GalleryBrowser } from "@/components/gallery/gallery-browser";
import { PublicShell } from "@/components/shell/public-shell";
import { plural } from "@/lib/format";
import { actorNav, currentActor, getGallery, NotFoundError, type Gallery } from "@/server/dal";

// Server-rendered on every request: every project is on page one, in a fresh
// shuffled order, so no project is always first. Nothing is baked in at build time.
export const dynamic = "force-dynamic";


function loadGallery(key: string): Gallery {
  try {
    return getGallery(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps<"/events/[event]">): Promise<Metadata> {
  const { event } = await params;
  try {
    return { title: `Projects · ${getGallery(event).event.name}` };
  } catch {
    return { title: "Event not found" };
  }
}

function shuffled<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default async function GalleryPage({ params, searchParams }: PageProps<"/events/[event]">) {
  const { event: key } = await params;
  const sp = await searchParams;
  const gallery = loadGallery(key);
  const actor = await currentActor();
  const { event, counts } = gallery;

  const items = shuffled(gallery.projects).map((p) => ({
    id: p.id,
    title: p.title,
    summary: p.summary,
    teamName: p.teamName,
    trackId: p.trackId,
    trackName: p.trackName,
  }));
  const tileFaces = Object.fromEntries(items.map((p) => [p.id, <Face key={p.id} id={p.id} />]));
  const smallFaces = Object.fromEntries(items.map((p) => [p.id, <Face key={p.id} id={p.id} cols={32} rows={18} />]));

  return (
    <PublicShell event={event} active="projects" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <div className="flex flex-col gap-3 pb-6 pt-8 md:flex-row md:items-end md:justify-between md:pb-8 md:pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Projects</h1>
        <p className="label-mono tnum text-ink-2 tracking-[0.06em] sm:tracking-[0.12em] md:pb-2">
          {plural(counts.projects, "project")} / {plural(counts.teams, "team")} / {plural(counts.tracks, "track")} / {plural(counts.judges, "judge")}
        </p>
      </div>
      <GalleryBrowser
        eventSlug={event.slug}
        items={items}
        tracks={gallery.tracks}
        tileFaces={tileFaces}
        smallFaces={smallFaces}
        initialTrack={typeof sp.track === "string" ? sp.track : null}
        initialQuery={typeof sp.q === "string" ? sp.q : ""}
      />
    </PublicShell>
  );
}
