import type { Metadata } from "next";
import { notFound, unauthorized } from "next/navigation";
import { Deadline } from "@/components/deadline";
import { PublicShell } from "@/components/shell/public-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getMyWork, NotFoundError, type MyWork } from "@/server/dal";
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
    <PublicShell event={event} active="none" signedInAs={actor.name} links={actorNav(actor)}>
      <div className="flex flex-wrap items-end justify-between gap-4 pb-8 pt-10">
        <div>
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
