import type { Metadata } from "next";
import { ExternalLink, FolderGit2, PlayCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { actorNav, currentActor, getPublicProject, NotFoundError } from "@/server/dal";

export const dynamic = "force-dynamic";

function load(event: string, project: string) {
  try {
    return getPublicProject(event, project);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: PageProps<"/events/[event]/projects/[project]">): Promise<Metadata> {
  const { event, project } = await params;
  try {
    const p = getPublicProject(event, project).project;
    return { title: p.title, description: p.summary };
  } catch {
    return { title: "Project not found" };
  }
}

function LinkButton({ href, icon, label }: { href: string; icon: React.ReactNode; label: string }) {
  let host = href;
  try {
    host = new URL(href).host + new URL(href).pathname.replace(/\/$/, "");
  } catch {}
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="inline-flex h-10 max-w-full items-center gap-2 rounded-sm border border-edge px-3.5 text-14 hover:bg-surface"
    >
      {icon}
      <span className="font-medium">{label}</span>
      <span className="truncate text-ink-3">{host}</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export default async function ProjectPage({ params }: PageProps<"/events/[event]/projects/[project]">) {
  const { event: eventKey, project: projectKey } = await params;
  const { event, project: p } = load(eventKey, projectKey);
  const actor = await currentActor();
  return (
    <PublicShell event={event} active="projects" signedInAs={actor?.name ?? null} links={actorNav(actor)}>
      <article className="pt-10">
        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)] md:items-start md:gap-12">
          <header>
            <p className="label-mono text-ink-3">
              {p.id} / {p.track.name}
            </p>
            <h1 className="mt-3 font-display text-[40px] leading-[46px] md:text-[56px] md:leading-[60px]">{p.title}</h1>
            {p.summary ? <p className="mt-4 font-serif text-[22px] leading-8 text-ink-2">{p.summary}</p> : null}
            <p className="mt-4 text-15 text-ink-2">
              by <span className="font-semibold text-ink">{p.team.name}</span> · {p.team.members}{" "}
              {p.team.members === 1 ? "member" : "members"}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              {p.repoUrl ? <LinkButton href={p.repoUrl} icon={<FolderGit2 className="size-4" aria-hidden />} label="Repository" /> : null}
              {p.videoUrl ? <LinkButton href={p.videoUrl} icon={<PlayCircle className="size-4" aria-hidden />} label="Demo video" /> : null}
              {p.liveUrl ? <LinkButton href={p.liveUrl} icon={<ExternalLink className="size-4" aria-hidden />} label="Live demo" /> : null}
              {!p.repoUrl && !p.videoUrl && !p.liveUrl ? <p className="text-14 text-ink-3">No links submitted.</p> : null}
            </div>
          </header>
          <div className="overflow-hidden rounded-xs border border-rule">
            <Face id={p.id} />
          </div>
        </div>

        <div className="mt-12 grid gap-10 border-t border-rule pt-10 md:grid-cols-[minmax(0,680px)_1fr] md:gap-16">
          <div>
            <h2 className="text-15 font-semibold">About the project</h2>
            {p.description ? (
              <div className="mt-4 space-y-5 font-serif text-17 leading-7 whitespace-pre-line">{p.description}</div>
            ) : (
              <p className="mt-4 text-15 text-ink-3">The team wrote no description beyond the summary.</p>
            )}
            {p.answers.length > 0 ? (
              <section className="mt-12 border-t border-rule pt-8" aria-labelledby="answers-title">
                <h2 id="answers-title" className="text-15 font-semibold">
                  The organizers asked
                </h2>
                <dl className="mt-4 flex flex-col gap-6">
                  {p.answers.map((a) => (
                    <div key={a.label}>
                      <dt className="text-14 text-ink-2">{a.label}</dt>
                      <dd className="mt-1 font-serif text-17 leading-7 whitespace-pre-line">{a.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ) : null}
          </div>
          <aside className="flex flex-col gap-6 text-14">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3">
              <dt className="text-ink-3">Track</dt>
              <dd>{p.track.name}</dd>
              <dt className="text-ink-3">Submitted</dt>
              <dd className="tnum">{formatUtc(p.submittedAt)}</dd>
              <dt className="text-ink-3">Team</dt>
              <dd>{p.team.name}</dd>
            </dl>
            <p className="border-t border-rule pt-5 text-13 text-ink-3">
              {event.resultsPublishedAt
                ? "Results are published: see the results page for this project's place."
                : "Scores stay with the judges and organizers until the results are published."}
            </p>
          </aside>
        </div>
      </article>
    </PublicShell>
  );
}
