import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { UpdateEntry } from "@/components/event-updates";
import { PublicShell } from "@/components/shell/public-shell";
import { plural } from "@/lib/format";
import { actorNav, currentActor, getAbout, listUpdates, NotFoundError, type About } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Updates" };

function load(key: string): About {
  try {
    return getAbout(key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

/** Every update the organizers posted, newest first, each in full. */
export default async function UpdatesPage({ params }: PageProps<"/events/[event]/updates">) {
  const { event: key } = await params;
  const { event } = load(key);
  const actor = await currentActor();
  const { updates, total } = listUpdates(event.id);
  return (
    <PublicShell event={event} active="about" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <div className="flex flex-col gap-3 pt-8 md:flex-row md:items-end md:justify-between md:pt-10">
        <h1 className="font-display text-[48px] leading-[52px] md:text-64">Updates</h1>
        <p className="label-mono tnum text-ink-2 tracking-[0.06em] sm:tracking-[0.12em] md:pb-2">{plural(total, "update")} / newest first / UTC</p>
      </div>
      {updates.length ? (
        <div className="mt-8 divide-y divide-rule border-y border-rule md:mt-10">
          {updates.map((u) => (
            <UpdateEntry key={u.id} u={u} />
          ))}
        </div>
      ) : (
        <p className="mt-8 rounded-sm border border-dashed border-edge px-5 py-6 text-14 text-ink-2 md:mt-10">The organizers have not posted an update yet.</p>
      )}
      <p className="mt-6 text-13 text-ink-3">
        <Link href={`/events/${event.slug}/about`} className="underline underline-offset-2 hover:text-ink">
          About the event
        </Link>
      </p>
    </PublicShell>
  );
}
