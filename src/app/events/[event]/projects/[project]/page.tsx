import type { Metadata } from "next";
import { ExternalLink, FolderGit2, PlayCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { ProjectImage } from "@/components/project-cover";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import Link from "next/link";
import { actorNav, currentActor, getPublicProject, listComments, NotFoundError } from "@/server/dal";
import { CommentForm, HideForm } from "./comments";

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
      <span className="shrink-0 font-medium">{label}</span>
      <span className="truncate text-ink-3">{host}</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export default async function ProjectPage({ params }: PageProps<"/events/[event]/projects/[project]">) {
  const { event: eventKey, project: projectKey } = await params;
  const { event, project: p } = load(eventKey, projectKey);
  const actor = await currentActor();
  const comments = listComments(actor, p.id);
  const canModerate = Boolean(actor?.roles.some((r) => r.eventId === event.id && r.role === "organizer"));
  const path = `/events/${event.slug}/projects/${p.id}`;
  return (
    <PublicShell event={event} active="projects" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <article className="pt-10">
        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)] md:items-start md:gap-12">
          <header className="min-w-0 wrap-anywhere">
            <p className="label-mono text-ink-3">
              {p.id} / {p.track.name}
            </p>
            <h1 className="mt-3 font-display text-[40px] leading-[46px] md:text-[56px] md:leading-[60px]">{p.title}</h1>
            {p.summary ? <p className="mt-4 font-serif text-[22px] leading-8 text-ink-2">{p.summary}</p> : null}
            <p className="mt-4 text-15 text-ink-2">
              by <span className="font-semibold text-ink">{p.team.name}</span> · {p.team.members}{" "}
              {p.team.members === 1 ? "member" : "members"}
            </p>
            {p.tags.length ? (
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Tech tags">
                {p.tags.map((t) => (
                  <li key={t}>
                    <Link
                      href={`/events/${event.slug}?q=${encodeURIComponent(t)}`}
                      className="inline-flex rounded-xs border border-rule px-2 py-0.5 font-mono text-13 text-ink-2 hover:border-edge hover:text-ink"
                    >
                      {t}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-6 flex flex-wrap gap-3">
              {p.repoUrl ? <LinkButton href={p.repoUrl} icon={<FolderGit2 className="size-4" aria-hidden />} label="Repository" /> : null}
              {p.videoUrl ? <LinkButton href={p.videoUrl} icon={<PlayCircle className="size-4" aria-hidden />} label="Demo video" /> : null}
              {p.liveUrl ? <LinkButton href={p.liveUrl} icon={<ExternalLink className="size-4" aria-hidden />} label="Live demo" /> : null}
              {!p.repoUrl && !p.videoUrl && !p.liveUrl ? <p className="text-14 text-ink-3">No links submitted.</p> : null}
            </div>
          </header>
          <div className="overflow-hidden rounded-xs border border-rule">
            {p.thumbnailUrl ? <ProjectImage src={p.thumbnailUrl} alt={`The team's picture of ${p.title}`} fallback={<Face id={p.id} />} /> : <Face id={p.id} />}
          </div>
        </div>

        <div className="mt-12 grid gap-10 border-t border-rule pt-10 md:grid-cols-[minmax(0,680px)_1fr] md:gap-16">
          <div>
            <h2 className="text-15 font-semibold">About the project</h2>
            {p.description ? (
              <div className="mt-4 space-y-5 font-serif text-17 leading-7 whitespace-pre-line wrap-anywhere">{p.description}</div>
            ) : (
              <p className="mt-4 text-15 text-ink-3">The team wrote no description beyond the summary.</p>
            )}
            {p.galleryUrls.length > 0 ? (
              <section className="mt-12 border-t border-rule pt-8" aria-labelledby="images-title">
                <h2 id="images-title" className="text-15 font-semibold">
                  Images
                </h2>
                <ul className="mt-4 grid gap-4 sm:grid-cols-2">
                  {p.galleryUrls.map((src, n) => (
                    <li key={src} className="overflow-hidden rounded-xs border border-rule">
                      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
                        <ProjectImage
                          src={src}
                          alt={`Image ${n + 1} of ${p.galleryUrls.length} from ${p.team.name}`}
                          fallback={<p className="flex aspect-video items-center justify-center p-4 text-13 text-ink-3">This image did not load. Open it on its own host.</p>}
                        />
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {p.answers.length > 0 ? (
              <section className="mt-12 border-t border-rule pt-8" aria-labelledby="answers-title">
                <h2 id="answers-title" className="text-15 font-semibold">
                  The organizers asked
                </h2>
                <dl className="mt-4 flex flex-col gap-6 wrap-anywhere">
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
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 wrap-anywhere">
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

        <section aria-labelledby="comments-title" className="mt-12 max-w-[680px] border-t border-rule pt-8 pb-16">
          <h2 id="comments-title" className="text-17 font-semibold">
            Comments <span className="font-normal text-ink-2">· {comments.filter((c) => !c.hidden).length}</span>
          </h2>
          {comments.length ? (
            <ol className="mt-4 flex flex-col divide-y divide-rule wrap-anywhere">
              {comments.map((c) => (
                <li key={c.id} className="py-4">
                  <p className="flex flex-wrap items-baseline justify-between gap-2 text-13 text-ink-2">
                    <span>
                      <span className="font-semibold text-ink">{c.author}</span> · {formatUtc(c.createdAt)}
                    </span>
                    {canModerate && !c.hidden ? <HideForm commentId={c.id} path={path} /> : null}
                  </p>
                  {c.hidden ? (
                    <p className="mt-2 text-14 text-ink-3 italic">Hidden by the organizers: {c.hidden.reason}</p>
                  ) : (
                    <p className="mt-2 font-serif text-17 leading-7 whitespace-pre-line">{c.body}</p>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-15 text-ink-2">No comments yet.</p>
          )}
          <div className="mt-6">
            {actor ? (
              <CommentForm projectId={p.id} path={path} />
            ) : (
              <p className="text-15 text-ink-2">
                <Link href={`/sign-in?next=${encodeURIComponent(path)}`} className="font-medium text-ink underline underline-offset-4">
                  Sign in
                </Link>{" "}
                to comment.
              </p>
            )}
          </div>
        </section>
      </article>
    </PublicShell>
  );
}
