import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OverallResults } from "@/components/results/overall-list";
import { PublicShell } from "@/components/shell/public-shell";
import { actorNav, currentActor, getGallery, getPublishedResults, NotFoundError, PAIRWISE_METHOD, type Gallery } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overall order" };

function load(key: string): Gallery {
  try {
    return getGallery(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

/** Every ranked project in one order by score, beside its place in its track; hidden exactly when the per-track results are. */
export default async function OverallResultsPage({ params }: PageProps<"/events/[event]/results/overall">) {
  const { event: key } = await params;
  const { event, counts } = load(key);
  const actor = await currentActor();
  // the per-track page's own read: whatever it publishes (and leaves out), this list shows in one order
  const results = getPublishedResults(event.id);
  const pairwise = results.published && results.method === PAIRWISE_METHOD;
  return (
    <PublicShell event={event} active="results" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <OverallResults results={results} pairwise={pairwise} eventSlug={event.slug} counts={counts} />
    </PublicShell>
  );
}
