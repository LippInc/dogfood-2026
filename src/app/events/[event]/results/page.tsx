import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getCommunityResults, getGallery, getPublishedResults, NotFoundError, type Gallery } from "@/server/dal";

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

/** Competition-style places for display: tied projects share the first place of their group. */
function places(rows: { score: number | null }[]): { place: number | null; joint: boolean }[] {
  return rows.map((r, i) => {
    if (r.score === null) return { place: null, joint: false };
    const first = rows.findIndex((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9);
    const joint = rows.filter((x) => x.score !== null && Math.abs(x.score - r.score!) <= 1e-9).length > 1;
    return { place: first + 1, joint: joint || first !== i };
  });
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

export default async function ResultsPage({ params }: PageProps<"/events/[event]/results">) {
  const { event: key } = await params;
  const { event, counts } = load(key);
  const actor = await currentActor();
  const results = getPublishedResults(event.id);
  const community = getCommunityResults(event.id);
  return (
    <PublicShell event={event} active="results" signedInAs={actor?.name ?? null} links={actorNav(actor)}>
      <div className="pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Results</h1>
      </div>
      {results.published ? (
        <>
          <p className="mt-6 max-w-[760px] text-17 text-ink-2">
            Published {formatUtc(results.publishedAt)}. Each project&rsquo;s score is its judges&rsquo; weighted rubric average, adjusted for how lenient each judge
            proved to be across the event{results.k !== null ? ` (k = ${results.k.toFixed(1)})` : ""}. Places compare within a track. Close scores are close:
            read small gaps as ties.
          </p>
          <div className="mt-10 flex flex-col gap-12">
            {results.tracks.map((t) => {
              const shown = places(t.rows);
              return (
                <section key={t.id} aria-labelledby={`track-${t.id}`}>
                  <h2 id={`track-${t.id}`} className="border-b border-rule pb-2 text-24 font-semibold">
                    {t.name}
                  </h2>
                  <ol className="divide-y divide-rule">
                    {t.rows.map((r, i) => {
                      const p = shown[i]!;
                      return (
                        <li key={r.projectId} className="tile grid grid-cols-[72px_64px_minmax(0,1fr)_auto] items-center gap-4 py-3 max-sm:grid-cols-[56px_minmax(0,1fr)_auto]">
                          <span className={`font-display tnum ${p.place === 1 ? "text-38 text-accent-ink" : "text-24"}`}>
                            {p.place === null ? "–" : p.place}
                            {p.joint ? <span className="ml-1 align-top font-sans text-12 text-ink-2">joint</span> : null}
                          </span>
                          <span className="max-sm:hidden">
                            <Face id={r.projectId} cols={32} rows={18} className="block h-9 w-16" />
                          </span>
                          <span className="min-w-0">
                            <Link href={`/events/${event.slug}/projects/${r.projectId}`} className="block truncate text-17 font-semibold hover:underline">
                              {r.title}
                            </Link>
                            <span className="block truncate text-14 text-ink-2">
                              {r.teamName}
                              {p.place !== null ? ` · ${ordinal(p.place)} in ${t.name}` : ""}
                            </span>
                          </span>
                          <span className="text-right">
                            <span className="block text-20 font-semibold tnum">{r.score === null ? "–" : r.score.toFixed(2)}</span>
                            <span className="block text-12 text-ink-2 tnum">
                              {r.n} {r.n === 1 ? "review" : "reviews"}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <section className="mt-10 max-w-[680px] border-t border-rule pt-8" aria-labelledby="hidden-title">
          <p className="label-mono text-accent-ink">Not yet published</p>
          <h2 id="hidden-title" className="mt-3 text-24 font-semibold">
            The results are hidden until the organizers publish them
          </h2>
          <p className="mt-3 text-17 text-ink-2">
            Judging covers {counts.projects} projects in {counts.tracks} tracks. Until the organizers publish, no score, average or rank leaves the judges&apos; and
            organizers&apos; screens, and the API refuses to hand them out. When they publish, this page shows each place with its score.
          </p>
        </section>
      )}
      {community.state === "not_set" ? null : (
        <section aria-labelledby="community-title" className="mt-16 max-w-[760px] border-t border-rule pt-8 pb-16">
          <p className="label-mono text-accent-ink">Community vote</p>
          <h2 id="community-title" className="mt-2 text-24 font-semibold">
            {community.tally ? "The community's favourites" : "Hidden until voting closes"}
          </h2>
          {community.tally ? (
            <ol className="mt-4 divide-y divide-rule border-y border-rule">
              {community.tally.map((t) => (
                <li key={t.projectId} className="grid grid-cols-[48px_minmax(0,1fr)_auto] items-baseline gap-3 py-2.5">
                  <span className="font-display text-20 tnum">{t.place}</span>
                  <span className="min-w-0 truncate">
                    <Link href={`/events/${event.slug}/projects/${t.projectId}`} className="font-semibold hover:underline">
                      {t.title}
                    </Link>{" "}
                    <span className="text-14 text-ink-2">· {t.teamName}</span>
                  </span>
                  <span className="text-15 font-semibold tnum">
                    {t.votes} {t.votes === 1 ? "vote" : "votes"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-17 text-ink-2">
              Voting {community.state === "upcoming" ? "has not opened yet" : "is open"}; nobody, organizers included, sees a count until it closes
              {community.closesAt ? ` on ${formatUtc(community.closesAt, { weekday: true })}` : ""}.
            </p>
          )}
        </section>
      )}
    </PublicShell>
  );
}
