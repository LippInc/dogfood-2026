import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getProjectJudging, type ProjectAssignment } from "@/server/dal";
import { WithReason } from "../../decisions";
import { removeAssignmentAction, undoRecusalAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Project judging" };

/** Where one review stands, in words; the flag colour only where the organizer has something to look at. */
function Standing({ a }: { a: ProjectAssignment }) {
  const state =
    a.status === "done" ? "Finished" : a.status === "recused" ? "Recused" : a.started ? "Started, not finished" : "Not started";
  const notes = [
    a.byHand ? "assigned by hand" : null,
    !a.isJudge ? "no longer a judge of this event" : !a.inTracks && a.status !== "recused" ? "outside their tracks now, so not in their list" : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-0.5 text-14">
      <p className={a.status === "recused" || !a.isJudge ? "text-flag" : a.status === "done" ? "text-ink" : "text-ink-2"}>
        {state}
        {notes.length ? <span className="text-13 text-ink-2"> · {notes.join(" · ")}</span> : null}
      </p>
      {a.recuseReason ? <p className="text-13 text-ink-2">Their reason: “{a.recuseReason}”</p> : null}
    </div>
  );
}

export default async function ProjectJudgingPage({ params }: PageProps<"/organize/[event]/submissions/[project]">) {
  const { event: key, project: projectId } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, project, assignments } = guardPage(() => getProjectJudging(actor, key, projectId));
  const published = Boolean(event.resultsPublishedAt);
  const counted = assignments.filter((a) => a.status !== "recused");
  const finished = assignments.filter((a) => a.status === "done").length;

  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Submissions")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-8">
        <header className="flex items-start gap-4">
          <Face id={project.id} cols={48} rows={27} className="mt-1 hidden h-[27px] w-12 shrink-0 sm:block" />
          <div className="min-w-0">
            <p className="text-13 text-ink-2">
              <Link href={`/organize/${event.slug}/submissions`} className="underline underline-offset-2 hover:text-ink">
                Submissions
              </Link>{" "}
              / {project.trackName}
            </p>
            <h1 className="mt-1 text-24 font-semibold wrap-anywhere">{project.title || "Untitled draft"}</h1>
            <p className="mt-2 text-15 text-ink-2 tnum">
              {project.teamName} · {project.status === "submitted" ? "submitted" : "draft"} · {finished} of {plural(counted.length, "review")} finished ·{" "}
              <span className="font-mono text-13 text-ink-3">{project.id}</span>
              {project.status === "submitted" ? (
                <>
                  {" "}
                  ·{" "}
                  <Link href={`/events/${event.slug}/projects/${project.id}`} className="underline underline-offset-2 hover:text-ink">
                    Public page
                  </Link>
                </>
              ) : null}
            </p>
          </div>
        </header>

        <section aria-labelledby="judges-title" className="flex max-w-[880px] flex-col gap-3">
          <div>
            <h2 id="judges-title" className="text-17 font-semibold">
              Judges of this project
            </h2>
            <p className="mt-1 text-14 text-ink-2">
              {published
                ? "Results are published, so the assignments are final."
                : "Take back a review the judge has not started, for a judge picked by mistake: no run gives it back to them. A started review stays, since it is the judge's work; if the project is not theirs to judge, they declare a conflict in their console. A recusal clicked by mistake can be undone: the review comes back as it was. Each change asks for a reason and goes into the audit log."}
            </p>
          </div>
          {assignments.length === 0 ? (
            <p className="rounded-sm border border-rule bg-surface p-6 text-15 text-ink-2">
              No judge has this project yet.{" "}
              <Link href={`/organize/${event.slug}/judges`} className="underline underline-offset-2 hover:text-ink">
                Assign judges on the Judges page
              </Link>
              .
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-rule rounded-sm border border-rule bg-surface">
              {assignments.map((a) => (
                <li
                  key={a.id}
                  className={`grid gap-x-6 gap-y-3 px-4 py-3.5 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-start ${
                    a.status === "recused" ? "shadow-[inset_3px_0_0_var(--flag-bar)]" : ""
                  }`}
                >
                  <div className="min-w-0">
                    <p className="font-medium wrap-anywhere">{a.judge}</p>
                    <p className="text-13 text-ink-2 wrap-anywhere">{a.email}</p>
                  </div>
                  <Standing a={a} />
                  <div className="flex md:justify-end">
                    {published ? null : a.status === "pending" && !a.started ? (
                      <WithReason
                        label="Take back…"
                        submit="Take back"
                        action={removeAssignmentAction}
                        hidden={{ assignment: a.id }}
                        eventSlug={event.slug}
                        idKey={`remove-${a.id}`}
                      />
                    ) : a.status === "recused" && a.isJudge ? (
                      <WithReason
                        label="Undo the recusal…"
                        submit="Give it back"
                        action={undoRecusalAction}
                        hidden={{ assignment: a.id }}
                        eventSlug={event.slug}
                        idKey={`unrecuse-${a.id}`}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </WorkShell>
  );
}
