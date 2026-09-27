import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { currentActor, organizedEvents } from "@/server/dal";
import { ImportEventForm } from "./import-form";

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
            <div className="flex items-center gap-3">
              <Link href="/organize/log" className="text-14 font-medium underline underline-offset-4">
                Portal log
              </Link>
              <Link href="/organize/new" className="inline-flex h-8 items-center rounded-sm border border-primary bg-primary px-3 text-14 font-medium text-on-primary">
                New event
              </Link>
            </div>
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
                <Link href={`/organize/${e.slug}`} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 hover:bg-raised">
                  <span className="min-w-0 text-15 font-medium wrap-anywhere">{e.name}</span>
                  <span className="text-13 text-ink-3">submissions close {formatUtc(e.submissionsCloseAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {canCreate ? (
          <section aria-labelledby="import-title" className="mt-10 flex flex-col gap-3 border-t border-rule pt-8">
            <h2 id="import-title" className="text-20 font-semibold">
              Import an event
            </h2>
            <p className="max-w-[680px] text-15 text-ink-2">
              From a file in the organizers&rsquo; fixture format: the <code className="font-mono text-13">fixtures.json</code> any event here
              exports, or one you wrote. Tracks, judges, teams, projects and scores come in; importing the same file again changes nothing. People
              who come in this way get into their accounts through personal links, made on the event&rsquo;s Integrations tab.
            </p>
            <ImportEventForm />
          </section>
        ) : null}
      </div>
    </WorkShell>
  );
}
