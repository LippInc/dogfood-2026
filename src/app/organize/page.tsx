import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { Face } from "@/components/face";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc, idLabel, isPast, plural } from "@/lib/format";
import { currentActor, getEventCards, organizedEvents, type Stage } from "@/server/dal";
import { ImportEventForm } from "./import-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your events" };

/**
 * The event's ten stages as a thin rail, in the overview pipeline's language: ink through the
 * stages reached, orange where a decision waits, an open square for the stage it is at.
 * Decorative: the line under it says the same in words.
 */
function StageRail({ stages }: { stages: Stage[] }) {
  const reached = stages.filter((s) => s.done).length;
  return (
    <ol aria-hidden className="flex">
      {stages.map((s, i) => (
        <li key={s.no} className="relative h-[10px] flex-1 last:w-[10px] last:flex-none">
          {i < stages.length - 1 ? <span className={`absolute top-[4px] right-0 left-0 h-[2px] ${i < reached - 1 ? "bg-ink" : "bg-rule"}`} /> : null}
          <span
            className={`absolute top-0 left-0 size-[10px] ${
              s.open ? "bg-flag-bar" : i < reached ? "bg-ink" : s.current ? "border-2 border-ink bg-surface" : "border-[1.5px] border-edge bg-surface"
            }`}
          />
        </li>
      ))}
    </ol>
  );
}

export default async function OrganizeHome() {
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { canCreate, events } = organizedEvents(actor);
  // Each card says where its event stands: the overview's pipeline and decisions, without its summary cards.
  const status = getEventCards(actor, events.map((e) => e.id));
  const cards = events.map((e, i) => ({ e, o: status[i]! }));
  return (
    <WorkShell eventName="Dogfood portal" eventHref="/organize" crumb="Your events" person={actor.name} role={actor.isAdmin ? "Administrator" : "Organizer"}>
      <div className="mx-auto max-w-[960px]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="label-mono text-ink-2">{plural(events.length, "event")}</p>
            <h1 className="mt-1 text-24 font-semibold">Your events</h1>
          </div>
          {canCreate ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link href="/organize/log" className="text-14 font-medium whitespace-nowrap underline underline-offset-4">
                Portal log
              </Link>
              <Link href="/organize/accounts" className="text-14 font-medium whitespace-nowrap underline underline-offset-4">
                Accounts
              </Link>
              <Link
                href="/organize/new"
                className="inline-flex h-8 items-center rounded-sm border border-primary bg-primary px-3 text-14 font-medium whitespace-nowrap text-on-primary max-sm:order-first"
              >
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
          // One card per event, full width: its generated face as a strip across the top (from the
          // event's id, like a project's), then who it is on the left and where it stands on the right.
          <ul className="mt-6 flex flex-col gap-5">
            {cards.map(({ e, o }) => {
              const label = idLabel(e.id);
              const closed = isPast(e.submissionsCloseAt);
              const now = o.pipeline.find((s) => s.current) ?? o.pipeline.filter((s) => s.done).at(-1) ?? o.pipeline[0];
              const reviews = o.judges.reviewsAssigned ? `${o.judges.reviewsDone} of ${o.judges.reviewsAssigned} reviews in` : "no reviews assigned yet";
              return (
                <li key={e.id} data-event={e.slug}>
                  <Link href={`/organize/${e.slug}`} className="tile group flex flex-col rounded-sm border border-rule bg-surface hover:border-edge">
                    <Face id={e.id} cols={96} rows={12} className="aspect-[8/1] w-full rounded-t-sm max-sm:hidden" />
                    <Face id={e.id} cols={48} rows={14} className="aspect-[24/7] w-full rounded-t-sm sm:hidden" />
                    <span className="grid gap-5 border-t border-rule p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] sm:gap-8 sm:p-5">
                      <span className="flex min-w-0 flex-col gap-1">
                        {label ? <span className="label-mono text-ink-3">{label}</span> : null}
                        <span className="text-20 font-semibold wrap-anywhere">{e.name}</span>
                        <span className="text-13 text-ink-2">
                          {closed ? "Submissions closed" : "Submissions close"} {formatUtc(e.submissionsCloseAt)}
                        </span>
                        <span className="mt-1 text-13 text-ink-2 tnum">
                          {o.judges.total ? plural(o.judges.total, "judge") : "No judges yet"} · {reviews}
                        </span>
                      </span>
                      <span className="flex min-w-0 flex-col gap-2.5 sm:pt-6">
                        <StageRail stages={o.pipeline} />
                        <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                          <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-14">
                            <span className="font-mono text-12 text-ink-3">{now.no}</span>
                            <span className="font-semibold">{now.name}</span>
                            <span className={now.open ? "font-medium text-flag" : "text-ink-2"}>{now.state}</span>
                          </span>
                          <span className="font-mono text-12 text-ink-3">
                            stage {Number(now.no)} of {o.pipeline.length}
                          </span>
                        </span>
                        {o.open ? (
                          <span className="border-l-[3px] border-flag-bar bg-flag-bg px-2.5 py-1.5 text-13 font-medium text-flag">
                            {o.open === 1 ? "1 decision waits on you" : `${o.open} decisions wait on you`}
                          </span>
                        ) : (
                          <span className="text-13 text-ink-2">{o.event.resultsPublishedAt ? "Results are published." : "Nothing waits on you."}</span>
                        )}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 border-t border-rule px-4 py-3 text-13 font-medium sm:px-5">
                      Open the overview
                      <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" aria-hidden />
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
              exports, or one you wrote. Tracks, judges, teams, projects and scores come in, and from a portal&rsquo;s own export also the rubric,
              the questions to teams and their answers; importing the same file again changes nothing. People
              who come in this way get into their accounts through personal links, made on the event&rsquo;s Integrations tab.
            </p>
            <ImportEventForm />
          </section>
        ) : null}
      </div>
    </WorkShell>
  );
}
