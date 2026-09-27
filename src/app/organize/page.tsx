import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Face } from "@/components/face";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc, idLabel, isPast } from "@/lib/format";
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
          <div>
            <p className="label-mono text-ink-2">{events.length === 1 ? "1 event" : `${events.length} events`}</p>
            <h1 className="mt-1 text-24 font-semibold">Your events</h1>
          </div>
          {canCreate ? (
            <div className="flex items-center gap-3">
              <Link href="/organize/log" className="text-14 font-medium underline underline-offset-4">
                Portal log
              </Link>
              <Link href="/organize/accounts" className="text-14 font-medium underline underline-offset-4">
                Accounts
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
          // Each event as a specimen card: its own generated face (from the event's id, like a
          // project's), its id label, its name and where it stands against its close.
          <ul className="mt-6 grid gap-4 sm:grid-cols-2">
            {events.map((e) => {
              const label = idLabel(e.id);
              const closed = isPast(e.submissionsCloseAt);
              return (
                <li key={e.id}>
                  <Link
                    href={`/organize/${e.slug}`}
                    className="tile group flex h-full flex-col rounded-sm border border-rule bg-surface hover:border-edge"
                  >
                    <Face id={e.id} cols={64} rows={28} className="aspect-[16/7] w-full rounded-t-sm" />
                    <span className="flex flex-1 flex-col gap-1 border-t border-rule p-4">
                      {label ? <span className="label-mono text-ink-3">{label}</span> : null}
                      <span className="text-20 font-semibold wrap-anywhere">{e.name}</span>
                      <span className="text-13 text-ink-2">
                        {closed ? "Submissions closed" : "Submissions close"} {formatUtc(e.submissionsCloseAt)}
                      </span>
                      <span className="mt-3 inline-flex items-center gap-1.5 text-13 font-medium">
                        Open the overview
                        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
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
