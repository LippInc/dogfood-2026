import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc, weightShares } from "@/lib/format";
import { actorNav, currentActor, getAbout, NotFoundError, type About } from "@/server/dal";

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
  const dates: [string, string | null][] = [
    ["Submissions open", event.submissionsOpenAt ? formatUtc(event.submissionsOpenAt, { weekday: true }) : "From the start"],
    ["Submissions close", formatUtc(event.submissionsCloseAt, { weekday: true })],
    ["Judging closes", event.judgingCloseAt ? formatUtc(event.judgingCloseAt, { weekday: true }) : "Set by the organizers"],
    ["Results", event.resultsPublishedAt ? `Published ${formatUtc(event.resultsPublishedAt)}` : "Not yet published"],
  ];
  return (
    <PublicShell event={event} active="about" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <div className="pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">About</h1>
        {event.description ? (
          <p className="mt-6 max-w-[680px] font-serif text-17 leading-7 whitespace-pre-line text-ink-2 wrap-anywhere">{event.description}</p>
        ) : null}
      </div>
      <div className="mt-12 grid gap-12 border-t border-rule pt-10 lg:grid-cols-3">
        <section aria-labelledby="dates-title">
          <h2 id="dates-title" className="label-mono text-ink">
            Dates, in UTC
          </h2>
          <dl className="mt-4 flex flex-col divide-y divide-rule border-y border-rule">
            {dates.map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-4 py-2.5">
                <dt className="text-14 text-ink-2">{label}</dt>
                <dd className="text-right text-14 font-medium tnum">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="tracks-title">
          <h2 id="tracks-title" className="label-mono text-ink">
            Tracks
          </h2>
          <ul className="mt-4 flex flex-col divide-y divide-rule border-y border-rule">
            {about.tracks.map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-4 py-2.5 text-14">
                <span className="min-w-0 wrap-anywhere">{t.name}</span>
                <span className="shrink-0 text-ink-3 tnum">
                  {t.count} {t.count === 1 ? "project" : "projects"}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="prizes-title">
          <h2 id="prizes-title" className="label-mono text-ink">
            Prizes
          </h2>
          {about.prizes.length ? (
            <ul className="mt-4 flex flex-col gap-4">
              {about.prizes.map((p) => (
                <li key={p.id} className="border-l-[3px] border-accent pl-4 wrap-anywhere">
                  <p className="text-15 font-semibold">{p.name}</p>
                  {p.description ? <p className="mt-1 text-14 text-ink-2">{p.description}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-14 text-ink-3">The organizers have not listed prizes yet.</p>
          )}
        </section>
      </div>
      <section aria-labelledby="rubric-title" className="mt-14 border-t border-rule pt-10">
        <h2 id="rubric-title" className="label-mono text-ink">
          How projects are judged
        </h2>
        <p className="mt-3 max-w-[680px] text-15 text-ink-2">
          Each judge scores every criterion from {about.rubric[0]?.scaleMin ?? 1} to {about.rubric[0]?.scaleMax ?? 5}. A
          review&apos;s total is the weighted mean of its criteria. Before ranking, the portal evens out judges who score
          harshly or generously, and shows its working next to every result.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-3">
          {about.rubric.map((c, i) => (
            <li key={c.key} className="rounded-sm border border-rule bg-surface p-5 wrap-anywhere">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 text-15 font-semibold">{c.label}</p>
                <p className="shrink-0 font-mono text-13 text-ink-3">weight {shares[i]}</p>
              </div>
              <p className="mt-1 text-14 text-ink-2">{c.prompt}</p>
            </li>
          ))}
        </ul>
      </section>
    </PublicShell>
  );
}
