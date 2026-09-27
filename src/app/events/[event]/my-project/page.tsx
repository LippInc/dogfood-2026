import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unauthorized } from "next/navigation";
import { Deadline } from "@/components/deadline";
import { PublicShell } from "@/components/shell/public-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getMyWork, myRecords, NotFoundError, PAIRWISE_METHOD, type MyWork } from "@/server/dal";
import { openOwnRecord } from "../../../records/actions";
import { ProjectForm } from "./project-form";
import { StartTeam, TeamPanel } from "./team-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your project" };

export default async function MyProjectPage({ params }: PageProps<"/events/[event]/my-project">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  let work: MyWork;
  try {
    work = getMyWork(actor, key);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
  const { event, team, project, open } = work;
  const closeLabel = formatUtc(event.submissionsCloseAt, { weekday: true });
  const certificate = work.feedback ? myRecords(actor, key).find((r) => r.kind === "participant") : undefined;
  const pairwise = work.feedback?.method === PAIRWISE_METHOD;
  const recordButton = "inline-flex h-10 items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-surface";

  const side = (
    <>
      <section aria-labelledby="deadline-title">
        <h2 id="deadline-title" className="label-mono text-ink-2">
          {open ? "Submissions close" : "Submissions closed"}
        </h2>
        <div className="mt-3">
          <Deadline iso={event.submissionsCloseAt} utcLabel={closeLabel} />
        </div>
      </section>
      {team ? <TeamPanel team={team} eventSlug={event.slug} open={open} /> : null}
    </>
  );

  return (
    <PublicShell event={event} active="none" signedInAs={actor.name} links={actorNav(actor, event.id)}>
      <div className="flex flex-wrap items-end justify-between gap-4 pb-8 pt-10">
        <div className="min-w-0 wrap-anywhere">
          <p className="label-mono text-ink-3">{team ? `Team ${team.name}` : "No team yet"}</p>
          <h1 className="mt-2 font-display text-[40px] leading-[46px] md:text-[52px] md:leading-[58px]">Your project</h1>
        </div>
        {project ? (
          <div className="flex items-center gap-3">
            {project.status === "submitted" ? (
              <Badge variant="ok">Submitted {formatUtc(project.submittedAt, { time: false })}</Badge>
            ) : (
              <Badge>Draft</Badge>
            )}
            <span className="font-mono text-12 text-ink-3">{project.id}</span>
          </div>
        ) : null}
      </div>
      {work.feedback ? (
        <section aria-labelledby="feedback-title" className="mb-10 border-y border-rule py-8">
          <p className="label-mono text-accent-ink">Results are published</p>
          <h2 id="feedback-title" className="mt-2 text-24 font-semibold">
            {work.feedback.place !== null ? `Place ${work.feedback.place} in ${work.feedback.trackName}` : "Not ranked"}
            {work.feedback.score !== null ? (
              <span className="font-normal text-ink-2">
                {" "}
                {pairwise ? (
                  <>
                    · wins {Math.round(work.feedback.score * 100)} %{work.feedback.se !== null ? ` ± ${Math.max(1, Math.round(work.feedback.se * 100))}` : ""} against the
                    track&rsquo;s average
                  </>
                ) : (
                  <>
                    · score {work.feedback.score.toFixed(2)}
                    {work.feedback.se !== null ? ` ± ${work.feedback.se.toFixed(2)}` : ""}
                  </>
                )}
              </span>
            ) : null}
          </h2>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {certificate ? (
              <Link href={`/records/${certificate.id}`} className={recordButton}>
                Your certificate
              </Link>
            ) : project?.status === "submitted" ? (
              <form action={openOwnRecord.bind(null, event.slug, "participant")}>
                <button className={recordButton}>Get your signed certificate</button>
              </form>
            ) : null}
            <span className="text-14 text-ink-2">Signed by the portal, so anyone can check it is real.</span>
          </div>
          <p className="mt-4 text-15 text-ink-2">
            {pairwise
              ? "Your place comes from the judges’ answers to “which of these two is better?”, with any scores given before the event switched to that way of judging counted as the order they imply. Your win % is your chance to beat an average project of your track. The written reviews below, judges unnamed, are the ones given as scores."
              : "Every review of your project, judges unnamed. The score is the reviews’ weighted average, adjusted for each judge’s leniency across the event."}
          </p>
          <ol className="mt-6 grid gap-4 md:grid-cols-2">
            {work.feedback.reviews.map((r, i) => (
              <li key={i} className={`rounded-sm border border-rule p-4 wrap-anywhere ${r.counted ? "" : "opacity-70"}`}>
                <p className="flex flex-wrap items-baseline justify-between gap-2 text-14">
                  <span className="font-semibold">Review {i + 1}</span>
                  <span className="text-ink-2 tnum">
                    {r.values.map((v) => `${v.label} ${v.value}`).join(" · ")} = {r.total.toFixed(2)}
                  </span>
                </p>
                <p className="mt-3 font-serif text-17 leading-7">{r.feedback || <span className="text-ink-3">No written feedback.</span>}</p>
                {r.counted ? null : (
                  <p className="mt-2 text-12 text-ink-2">Not counted: this judge gave the same scores to every project, so the organizers left them out.</p>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {!team ? (
        <StartTeam eventSlug={event.slug} open={open} />
      ) : (
        <ProjectForm
          eventSlug={event.slug}
          open={open}
          tracks={work.tracks}
          questions={work.questions}
          project={
            project
              ? {
                  id: project.id,
                  title: project.title,
                  summary: project.summary,
                  description: project.description,
                  trackId: project.trackId,
                  repoUrl: project.repoUrl,
                  videoUrl: project.videoUrl,
                  liveUrl: project.liveUrl,
                  thumbnailUrl: project.thumbnailUrl,
                  galleryUrls: project.galleryUrls,
                  tags: project.tags,
                  status: project.status,
                  answers: project.answers,
                }
              : null
          }
          side={side}
        />
      )}
    </PublicShell>
  );
}
