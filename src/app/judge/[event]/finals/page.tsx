import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { WorkShell } from "@/components/shell/work-shell";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getPanelFinals } from "@/server/dal";
import { FinalsScoreForm } from "./score-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Finals" };

/** A panelist's finals: only the rounds they sit on, only the finalists, only their own scores (getPanelFinals). */
export default async function PanelFinalsPage({ params }: PageProps<"/judge/[event]/finals">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const v = guardPage(() => getPanelFinals(actor, key));
  // a finalist this panelist may not score (a conflict of interest) is not theirs to score, so it is not counted
  const total = v.rounds.reduce((n, r) => n + r.finalists.filter((f) => !f.conflict).length, 0);
  const done = v.rounds.reduce((n, r) => n + r.finalists.filter((f) => f.mine && !f.conflict).length, 0);
  return (
    <WorkShell eventName={v.event.name} eventHref={`/events/${v.event.slug}`} crumb="Finals" person={actor.name} role="Judge">
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-3">
          <div className="max-w-[72ch]">
            <h1 className="text-24 font-semibold">Finals</h1>
            <p className="mt-2 text-15 text-ink-2">
              You sit on the finals panel. Score each finalist on the same rubric as the first round, except one from your own team or one you recused
              from; nobody on the panel sees another panelist&apos;s scores.
            </p>
            {v.out ? (
              <p className="mt-3 border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag">
                {v.out === "removed"
                  ? "The organizers removed you from this event\u2019s judges, so your finals scores stay on record but do not count in the finals order."
                  : "The organizers left you out of the ranking, so your finals scores stay on record but do not count in the finals order."}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col items-start gap-1 sm:items-end">
            <p className="text-15 tnum">
              <span className="font-display text-24">{done}</span> / {total} scored
            </p>
            <Link href={`/judge/${v.event.slug}`} className="text-13 underline decoration-edge underline-offset-4 hover:decoration-ink">
              Back to the first round
            </Link>
          </div>
        </header>
        {v.rounds.map((r) => (
          <section key={r.id} aria-labelledby={`round-${r.id}`} className="flex flex-col gap-5 border-t border-rule pt-6">
            <h2 id={`round-${r.id}`} className="text-20 font-semibold">
              Finals · {r.trackName ?? "Every track"}
              {r.closed || v.published ? <span className="ml-3 text-13 font-normal text-ink-2">closed: the scores are final</span> : null}
            </h2>
            <ol className="flex flex-col gap-6">
              {r.finalists.map((f) => (
                <li key={f.projectId} className="grid grid-cols-[minmax(0,1fr)] gap-5 rounded-sm border border-rule bg-surface p-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <div className="flex min-w-0 flex-col gap-2">
                    <h3 className="text-17 font-semibold">{f.title}</h3>
                    <p className="text-13 text-ink-2">
                      {f.teamName} · {f.trackName}
                    </p>
                    {f.summary ? <p className="text-14">{f.summary}</p> : null}
                    <p className="flex flex-wrap gap-x-4 gap-y-1 text-13">
                      {f.repoUrl ? <a className="underline decoration-edge underline-offset-4 hover:decoration-ink" href={f.repoUrl} target="_blank" rel="noreferrer noopener">Code</a> : null}
                      {f.videoUrl ? <a className="underline decoration-edge underline-offset-4 hover:decoration-ink" href={f.videoUrl} target="_blank" rel="noreferrer noopener">Video</a> : null}
                      {f.liveUrl ? <a className="underline decoration-edge underline-offset-4 hover:decoration-ink" href={f.liveUrl} target="_blank" rel="noreferrer noopener">Live</a> : null}
                    </p>
                    <p className="mt-auto text-13 text-ink-2 tnum">
                      {f.conflict ? "Conflict of interest" : f.mine ? `Your score ${f.mine.total === null ? "–" : f.mine.total.toFixed(2)}, saved ${formatUtc(f.mine.savedAt)}` : "Not scored yet"}
                    </p>
                  </div>
                  {f.conflict ? (
                    <p className="self-start border-l-[3px] border-rule pl-3 text-15 text-ink-2">
                      {f.conflict === "own_team"
                        ? "Not yours to score: this is your own team\u2019s project. The finals do not wait for your score on it."
                        : "Not yours to score: you recused yourself from this project in the first round. The finals do not wait for your score on it."}
                    </p>
                  ) : (
                    <FinalsScoreForm
                      eventSlug={v.event.slug}
                      finalsId={r.id}
                      projectId={f.projectId}
                      title={f.title}
                      criteria={v.criteria}
                      values={f.mine?.values ?? null}
                      readOnly={r.closed || v.published}
                    />
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </WorkShell>
  );
}
