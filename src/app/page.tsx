import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { actorNav, currentActor, getGallery, listEvents, type PublicEvent } from "@/server/dal";
import { eventPhase, idLabel, plural } from "@/lib/format";
import { Face } from "@/components/face";
import { PlainShell } from "@/components/shell/plain-shell";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Events" };

/** What is on now comes first, then what is coming, then what is over; the portal's own order within each. */
const PHASE_ORDER: Record<string, number> = { open: 0, judging: 1, upcoming: 2, judged: 3, published: 4 };

/** The phase's marker, as on the About page's timeline: pink is now, hollow is to come, ink is over. */
function PhaseMark({ phase }: { phase: string }) {
  const now = phase === "open" || phase === "judging";
  const cls = now ? "bg-accent" : phase === "upcoming" ? "border border-edge" : "bg-ink";
  return <span aria-hidden="true" className={`inline-block size-2 shrink-0 ${cls}`} />;
}

function EventRow({ e, projects, tracks }: { e: PublicEvent; projects: number; tracks: number }) {
  const phase = eventPhase(e);
  const [status, ...detail] = phase.parts;
  const label = idLabel(e.id);
  return (
    <Link
      href={`/events/${e.slug}`}
      className="tile group grid rounded-sm md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      data-event={e.slug}
    >
      {/* the event's face (from its id, as on the organizer's cards) on a sunken plate that fills the row's height */}
      <span className="flex items-center rounded-t-sm border-b border-rule bg-sunken p-4 md:rounded-l-sm md:rounded-tr-none md:border-r md:border-b-0 md:p-6">
        <span className="relative block w-full">
          <Face id={e.id} cols={64} rows={28} className="aspect-[16/7] w-full rounded-xs" />
          <span className="crop-marks" aria-hidden="true" />
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-3 p-5 md:px-8 md:py-6">
        <span className="flex items-center justify-between gap-4">
          <span className="label-mono flex items-center gap-2 text-ink">
            <PhaseMark phase={phase.key} />
            {status}
          </span>
          {label ? <span className="label-mono text-ink-3">{label}</span> : null}
        </span>
        <span className="font-display text-24 wrap-anywhere md:text-38">{e.name}</span>
        {e.description ? <span className="line-clamp-2 text-15 text-ink-2">{e.description}</span> : null}
        {detail.length > 0 ? <span className="text-14 text-ink-2">{detail.map((d) => d.replace(/^Close /, "Closes ")).join(" · ")}</span> : null}
        <span className="mt-auto flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-rule pt-4">
          <span className="label-mono tnum text-ink-2">
            {plural(projects, "project")} / {plural(tracks, "track")}
          </span>
          <span className="inline-flex items-center gap-1.5 text-14 font-medium group-hover:text-accent-ink">
            Open the gallery
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
          </span>
        </span>
      </span>
    </Link>
  );
}

/** One event: go straight to its gallery. Several: list them. None: the way to the first one. */
export default async function Home() {
  const events = listEvents();
  if (events.length === 1) redirect(`/events/${events[0].slug}`);
  const actor = await currentActor();
  const organizes = Boolean(actor && (actor.isAdmin || actor.roles.some((r) => r.role === "organizer")));
  const mine = actor ? actorNav(actor) : [];
  const rows = events
    .map((e, i) => {
      const { counts } = getGallery(e.id);
      return { e, i, projects: counts.projects, tracks: counts.tracks, order: PHASE_ORDER[eventPhase(e).key] ?? 5 };
    })
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const totalProjects = rows.reduce((n, r) => n + r.projects, 0);
  return (
    <PlainShell account={actor ? { name: actor.name } : null}>
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Events</h1>
        {events.length > 0 ? (
          <p className="label-mono tnum text-ink-2 md:pb-2">
            {plural(events.length, "event")} / {plural(totalProjects, "project")}
          </p>
        ) : null}
      </div>
      {events.length === 0 ? (
        actor?.isAdmin ? (
          <div className="mt-6 flex flex-col gap-4">
            <p className="text-17 text-ink-2">No events yet. You administer this portal: create the first event, or import one from a file in the organizers&rsquo; fixture format.</p>
            <div className="flex flex-wrap gap-3">
              <Link href="/organize/new" className={buttonVariants({ size: "lg" })}>
                Create an event
              </Link>
              <Link href="/organize" className={buttonVariants({ variant: "outline", size: "lg" })}>
                Import an event
              </Link>
            </div>
          </div>
        ) : (
          <p className="mt-6 text-17 text-ink-2">
            No events yet. An administrator of this portal creates the first one
            {actor ? "." : (
              <>
                ; if that is you,{" "}
                <Link href="/sign-in" className="underline underline-offset-4">
                  sign in
                </Link>
                .
              </>
            )}
          </p>
        )
      ) : (
        <ul className="mt-8 flex flex-col gap-5 border-t border-rule pt-8 md:mt-10 md:pt-10">
          {rows.map((r) => (
            <li key={r.e.id} className="rounded-sm border border-rule bg-surface">
              <EventRow e={r.e} projects={r.projects} tracks={r.tracks} />
            </li>
          ))}
        </ul>
      )}
      {mine.length > 0 ? (
        <section aria-labelledby="mine-title" className="mt-10">
          <h2 id="mine-title" className="label-mono text-ink-2">
            Where you take part
          </h2>
          <ul className="mt-3 flex flex-col gap-2 text-15">
            {mine.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="underline decoration-edge underline-offset-4 hover:decoration-ink">
                  {l.event}: {l.label.toLowerCase()}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {organizes && events.length > 0 ? (
        <p className="mt-8 text-15">
          <Link href="/organize" className="underline underline-offset-4">
            Your events
          </Link>
        </p>
      ) : null}
    </PlainShell>
  );
}
