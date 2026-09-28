import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { actorNav, currentActor, getGallery, listEvents, type NavLink, type PublicEvent } from "@/server/dal";
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
  return <span aria-hidden="true" className={`mt-1 inline-block size-2 shrink-0 ${cls}`} />;
}

/** The reader's own way into an event, named for where it goes. */
const PART_LABEL: Record<string, string> = { Organizer: "Organizer overview", "Judge console": "Judge console", "My project": "My project" };

/** Under an event's sheet: the reader's part in it (organizer, judge, participant) as links. */
function YourPart({ links }: { links: NavLink[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-rule px-5 py-3 md:px-8">
      <span className="label-mono text-ink-3">Your part</span>
      {links.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="inline-flex min-h-8 items-center gap-1.5 text-14 font-medium underline decoration-edge underline-offset-4 hover:decoration-ink"
        >
          {PART_LABEL[l.label] ?? l.label}
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      ))}
    </div>
  );
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
      {/* the event's face (from its id, as on the organizer's cards), its ground carried to the sheet's edges */}
      <span className="flex items-center rounded-t-sm border-b border-rule bg-face-bg p-5 md:rounded-l-sm md:rounded-tr-none md:border-r md:border-b-0 md:p-8">
        <span className="relative block w-full">
          <Face id={e.id} cols={64} rows={28} className="aspect-[16/7] w-full rounded-xs" />
          <span className="crop-marks" aria-hidden="true" />
        </span>
      </span>
      <span className="flex min-w-0 flex-col gap-3 p-5 md:px-8 md:py-6">
        <span className="flex items-center justify-between gap-4">
          <span className="label-mono flex items-start gap-2 text-ink">
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
  const organized = actor ? actor.roles.filter((r) => r.role === "organizer").length : 0;
  const rows = events
    .map((e, i) => {
      const { counts } = getGallery(e.id);
      const part = actor ? actorNav(actor, e.id) : [];
      return { e, i, part, projects: counts.projects, tracks: counts.tracks, order: PHASE_ORDER[eventPhase(e).key] ?? 5 };
    })
    .sort((a, b) => a.order - b.order || a.i - b.i);
  const totalProjects = rows.reduce((n, r) => n + r.projects, 0);
  return (
    <PlainShell account={actor ? { name: actor.name } : null}>
      <div className="flex flex-col gap-3 border-b border-rule pb-8 md:flex-row md:items-end md:justify-between md:pb-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Events</h1>
        {events.length > 0 ? (
          <p className="label-mono tnum text-ink-2 md:pb-2">
            {plural(events.length, "event")} / {plural(totalProjects, "project")}
          </p>
        ) : null}
      </div>
      {organizes && events.length > 0 ? (
        <div className="mt-8 flex flex-wrap items-center gap-3 rounded-sm border border-dashed border-edge px-5 py-3">
          <p className="label-mono w-full text-ink-2 sm:mr-auto sm:w-auto">
            {actor?.isAdmin ? "You administer this portal" : `You organize ${plural(organized, "event")} here`}
          </p>
          <Link href="/organize" className={buttonVariants({ variant: actor?.isAdmin ? "link" : "outline" })}>
            Your events
          </Link>
          {actor?.isAdmin ? (
            <>
              <Link href="/organize#import-title" className={buttonVariants({ variant: "outline" })}>
                Import an event
              </Link>
              <Link href="/organize/new" className={buttonVariants()}>
                Create an event
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
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
        <ul className="mt-8 flex flex-col gap-5">
          {rows.map((r) => (
            <li key={r.e.id} className="rounded-sm border border-rule bg-surface">
              <EventRow e={r.e} projects={r.projects} tracks={r.tracks} />
              {r.part.length > 0 ? <YourPart links={r.part} /> : null}
            </li>
          ))}
        </ul>
      )}
    </PlainShell>
  );
}
