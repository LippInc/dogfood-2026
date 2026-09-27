import Link from "next/link";
import { redirect } from "next/navigation";
import { actorNav, currentActor, listEvents } from "@/server/dal";
import { formatUtc } from "@/lib/format";
import { PlainShell } from "@/components/shell/plain-shell";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-dynamic";

/** One event: go straight to its gallery. Several: list them. None: the way to the first one. */
export default async function Home() {
  const events = listEvents();
  if (events.length === 1) redirect(`/events/${events[0].slug}`);
  const actor = await currentActor();
  const organizes = Boolean(actor && (actor.isAdmin || actor.roles.some((r) => r.role === "organizer")));
  const mine = actor ? actorNav(actor) : [];
  return (
    <PlainShell width="max-w-3xl" account={actor ? { name: actor.name } : null}>
      <h1 className="font-display text-38">Events</h1>
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
        <ul className="mt-8 divide-y divide-rule border-y border-rule">
          {events.map((e) => (
            <li key={e.id}>
              <Link href={`/events/${e.slug}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-4 hover:text-accent-ink">
                <span className="min-w-0 font-display text-20">{e.name}</span>
                <span className="label-mono text-ink-3">closes {formatUtc(e.submissionsCloseAt)}</span>
              </Link>
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
