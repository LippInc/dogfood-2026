import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/shell/public-shell";
import { plural, weightShares } from "@/lib/format";
import { LatestUpdates } from "@/components/event-updates";
import { actorNav, currentActor, getAbout, listUpdates, NotFoundError, UPDATES_SHOWN, type About } from "@/server/dal";
import { Rubric } from "./rubric";
import { stagesOf, Timeline } from "./timeline";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "About" };

function load(key: string): About {
  try {
    return getAbout(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export default async function AboutPage({ params }: PageProps<"/events/[event]/about">) {
  const { event: key } = await params;
  const about = load(key);
  const actor = await currentActor();
  const { event } = about;
  const shares = weightShares(about.rubric.map((c) => c.weight));
  const projects = about.tracks.reduce((n, t) => n + t.count, 0);
  return (
    <PublicShell event={event} active="about" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <div className="flex flex-col gap-3 pt-8 md:flex-row md:items-end md:justify-between md:pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">About</h1>
        <p className="label-mono tnum text-ink-2 tracking-[0.06em] sm:tracking-[0.12em] md:pb-2">
          {plural(about.tracks.length, "track")} / {plural(projects, "project")} / {plural(about.rubric.length, "criterion", "criteria")}
        </p>
      </div>
      {event.description ? (
        <p className="mt-6 max-w-[680px] font-serif text-17 leading-7 whitespace-pre-line text-ink-2 wrap-anywhere">{event.description}</p>
      ) : null}
      <LatestUpdates slug={event.slug} {...listUpdates(event.id, UPDATES_SHOWN)} className="mt-8 md:mt-10" />
      <section aria-labelledby="dates-title" className="mt-8 border-t border-rule pt-6 md:mt-10">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-5">
          <h2 id="dates-title" className="label-mono text-ink">
            Fig. 01 — When it happens
          </h2>
          <p className="text-13 text-ink-3">Every time in UTC.</p>
        </div>
        <Timeline stages={stagesOf(event)} />
      </section>
      <section aria-labelledby="rubric-title" className="mt-12 border-t border-rule pt-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-5">
          <h2 id="rubric-title" className="label-mono text-ink">
            Fig. 02 — How projects are judged
          </h2>
          <p className="text-13 text-ink-3">The weights are the organizers&apos; setting.</p>
        </div>
        <Rubric rubric={about.rubric} shares={shares} resultsHref={`/events/${event.slug}/results`} />
      </section>
      <div className="mt-12 grid gap-12 border-t border-rule pt-6 lg:grid-cols-2">
        <section aria-labelledby="tracks-title">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-5">
            <h2 id="tracks-title" className="label-mono text-ink">
              Tracks
            </h2>
            <p className="text-13 text-ink-3">Each project enters one. Choose a track to see its projects.</p>
          </div>
          <ul className="mt-6 flex flex-col divide-y divide-rule border-y border-rule">
            {about.tracks.map((t, i) => (
              <li key={t.id}>
                <Link
                  href={`/events/${event.slug}?track=${encodeURIComponent(t.id)}`}
                  className="group grid min-h-11 grid-cols-[auto_1fr_auto] items-center gap-x-4 py-2.5 text-15"
                >
                  <span className="font-mono text-12 text-ink-3">{String(i + 1).padStart(2, "0")}</span>
                  <span className="min-w-0 wrap-anywhere group-hover:underline">{t.name}</span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="hidden gap-[3px] sm:flex" aria-hidden="true">
                      {Array.from({ length: Math.min(t.count, 24) }, (_, k) => (
                        <span key={k} className="size-2 bg-face-dot group-hover:bg-accent" />
                      ))}
                    </span>
                    <span className="w-20 text-right text-14 text-ink-3 tnum">{plural(t.count, "project")}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="prizes-title">
          <h2 id="prizes-title" className="label-mono text-ink">
            Prizes
          </h2>
          {about.prizes.length ? (
            <ol className="mt-6 grid gap-x-6 gap-y-8 sm:grid-cols-2">
              {about.prizes.map((p, i) => (
                <li key={p.id} className="border-t-2 border-ink pt-3 wrap-anywhere">
                  <p className="font-mono text-12 text-accent-ink">{String(i + 1).padStart(2, "0")}</p>
                  <h3 className="mt-2 text-17 font-semibold">{p.name}</h3>
                  {p.description ? <p className="mt-1 text-14 text-ink-2">{p.description}</p> : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-6 rounded-sm border border-dashed border-edge px-5 py-6 text-14 text-ink-2">
              The organizers have not listed prizes yet.
            </p>
          )}
        </section>
      </div>
    </PublicShell>
  );
}
