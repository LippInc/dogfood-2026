import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getGallery, NotFoundError, type Gallery } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Results" };

function load(key: string): Gallery {
  try {
    return getGallery(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export default async function ResultsPage({ params }: PageProps<"/events/[event]/results">) {
  const { event: key } = await params;
  const { event, counts } = load(key);
  const actor = await currentActor();
  return (
    <PublicShell event={event} active="results" signedInAs={actor?.name ?? null} links={actorNav(actor)}>
      <div className="pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Results</h1>
      </div>
      {event.resultsPublishedAt ? (
        <p className="mt-8 text-17 text-ink-2">Published {formatUtc(event.resultsPublishedAt)}.</p>
      ) : (
        <section className="mt-10 max-w-[680px] border-t border-rule pt-8" aria-labelledby="hidden-title">
          <p className="label-mono text-accent-ink">Not yet published</p>
          <h2 id="hidden-title" className="mt-3 text-24 font-semibold">
            The results are hidden until the organizers publish them
          </h2>
          <p className="mt-3 text-17 text-ink-2">
            Judging covers {counts.projects} projects in {counts.tracks} tracks. Until the organizers publish, no score,
            average or rank leaves the judges&apos; and organizers&apos; screens, and the API refuses to hand them out.
            When they publish, this page shows each place with the working behind it.
          </p>
        </section>
      )}
    </PublicShell>
  );
}
