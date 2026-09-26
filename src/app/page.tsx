import Link from "next/link";
import { redirect } from "next/navigation";
import { listEvents } from "@/server/dal";
import { formatUtc } from "@/lib/format";

export const dynamic = "force-dynamic";

/** One event: go straight to its gallery. Several: list them. */
export default async function Home() {
  const events = listEvents();
  if (events.length === 1) redirect(`/events/${events[0].slug}`);
  return (
    <div className="public min-h-dvh">
      <main className="mx-auto max-w-3xl px-4 py-16 sm:px-8">
        <h1 className="font-display text-38">Events</h1>
        {events.length === 0 ? (
          <p className="mt-6 text-17 text-ink-2">No events yet. An administrator can create the first one.</p>
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
      </main>
    </div>
  );
}
