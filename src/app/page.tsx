import Link from "next/link";
import { redirect } from "next/navigation";
import { currentActor, listEvents } from "@/server/dal";
import { formatUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

/** One event: go straight to its gallery. Several: list them. None: the way to the first one. */
export default async function Home() {
  const events = listEvents();
  if (events.length === 1) redirect(`/events/${events[0].slug}`);
  const actor = await currentActor();
  const organizes = Boolean(actor && (actor.isAdmin || actor.roles.some((r) => r.role === "organizer")));
  return (
    <div className="public min-h-dvh">
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
        <h1 className="font-display text-38">Events</h1>
        {events.length === 0 ? (
          actor?.isAdmin ? (
            <div className="mt-6 flex flex-col gap-4">
              <p className="text-17 text-ink-2">No events yet. You administer this portal: create the first event, or import one from a file in the organizers&rsquo; fixture format.</p>
              <div className="flex flex-wrap gap-3">
                <Link href="/organize/new" className="inline-flex h-9 items-center rounded-sm border border-primary bg-primary px-4 text-14 font-medium text-on-primary">
                  Create an event
                </Link>
                <Link href="/organize" className="inline-flex h-9 items-center rounded-sm border border-edge px-4 text-14 font-medium">
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
          <ul className="mt-8 divide-y divide-rule border-y border-rule">
            {events.map((e) => (
              <li key={e.id}>
                <Link href={`/events/${e.slug}`} className="flex items-baseline justify-between gap-4 py-4 hover:text-accent-ink">
                  <span className="font-display text-20">{e.name}</span>
                  <span className="label-mono text-ink-3">closes {formatUtc(e.submissionsCloseAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {organizes && events.length > 0 ? (
          <p className="mt-8 text-15">
            <Link href="/organize" className="underline underline-offset-4">
              Your events
            </Link>
          </p>
        ) : null}
      </main>
    </div>
  );
}
