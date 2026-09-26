import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { currentActor, organizedEvents } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your events" };

export default async function OrganizeHome() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { canCreate, events } = organizedEvents(actor);
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="Your events" person={actor.name} role={actor.isAdmin ? "Administrator" : "Organizer"}>
      <div className="mx-auto max-w-[960px]">
        <div className="flex items-end justify-between gap-4">
          <h1 className="text-24 font-semibold">Your events</h1>
          {canCreate ? (
            <Link href="/organize/new" className="inline-flex h-8 items-center rounded-sm border border-primary bg-primary px-3 text-14 font-medium text-on-primary">
              New event
            </Link>
          ) : null}
        </div>
        {events.length === 0 ? (
          <p className="mt-6 text-15 text-ink-2">
            You organize no event yet.{" "}
            {canCreate ? "Create one to start." : "An administrator of this portal creates events and adds organizers."}
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-rule border-y border-rule bg-surface">
            {events.map((e) => (
              <li key={e.id}>
                <Link href={`/organize/${e.slug}`} className="flex items-baseline justify-between gap-4 px-4 py-3 hover:bg-raised">
                  <span className="text-15 font-medium">{e.name}</span>
                  <span className="text-13 text-ink-3">submissions close {formatUtc(e.submissionsCloseAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </WorkShell>
  );
}
