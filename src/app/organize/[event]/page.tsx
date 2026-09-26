import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { eventPhase, formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getGallery, getOrganizerEvent } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

export default async function OverviewPage({ params }: PageProps<"/organize/[event]">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const o = guardPage(() => getOrganizerEvent(actor, key));
  const { event } = o;
  const { counts } = getGallery(event.id);
  const phase = eventPhase(event);
  const cards: [string, string, string][] = [
    [String(counts.projects), "projects submitted", `/events/${event.slug}`],
    [String(counts.teams), "teams", `/organize/${event.slug}/submissions`],
    [String(counts.judges), "judges", `/organize/${event.slug}/judges`],
    [String(counts.tracks), "tracks", `/organize/${event.slug}/settings#tracks-title`],
  ];
  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Overview")}
      tools={
        <a
          href={`/api/events/${event.id}/export/scores.csv`}
          className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised"
        >
          Export CSV
        </a>
      }
      person={actor.name}
      role="Organizer"
    >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <p className="label-mono text-ink-3">{phase.parts.join(" / ")}</p>
            <h1 className="mt-2 text-24 font-semibold">{event.name}</h1>
          </div>
          <p className="text-14 text-ink-2">Submissions close {formatUtc(event.submissionsCloseAt, { weekday: true })}</p>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {cards.map(([n, label, href]) => (
            <li key={label}>
              <Link href={href} className="block rounded-sm border border-rule bg-surface p-5 hover:border-edge">
                <p className="text-38 leading-none font-semibold tnum">{n}</p>
                <p className="mt-2 text-14 text-ink-2">{label}</p>
              </Link>
            </li>
          ))}
        </ul>
        <section className="rounded-sm border border-rule bg-surface p-5">
          <h2 className="text-17 font-semibold">Exports</h2>
          <p className="mt-1 text-14 text-ink-2">Always available, with a header row even before anything is scored.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {["scores.csv", "projects.csv"].map((f) => (
              <a key={f} href={`/api/events/${event.id}/export/${f}`} className="inline-flex h-8 items-center rounded-sm border border-edge px-3 font-mono text-13 hover:bg-raised">
                {f}
              </a>
            ))}
          </div>
        </section>
      </div>
    </WorkShell>
  );
}
