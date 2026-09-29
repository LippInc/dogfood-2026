import type { Metadata } from "next";
import { ExternalLink, FolderGit2, PlayCircle } from "lucide-react";
import { notFound } from "next/navigation";
import { Face } from "@/components/face";
import { ProjectImage } from "@/components/project-cover";
import { PublicShell } from "@/components/shell/public-shell";
import { formatUtc } from "@/lib/format";
import { competitionPlaces, ordinal } from "@/lib/places";
import Link from "next/link";
import { actorNav, currentActor, getGallery, getMyWork, getPublicProject, getPublishedResults, listComments, NotFoundError, PAIRWISE_METHOD } from "@/server/dal";
import { CommentForm, DeleteOwnComment, ModerateComment } from "./comments";
import { TakeDownPicture } from "./take-down";
import { trackMoveWords } from "@/lib/track-move";

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
    const { event: e, project: p } = getPublicProject(event, project);
    // A pasted link shows a card: the project and its event as the title, its one line under it (no image).
    const title = `${p.title} · ${e.name}`;
    return { title: p.title, description: p.summary, openGraph: { title, description: p.summary || undefined, type: "article", siteName: e.name } };
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
  const { event, project: p, fields } = load(eventKey, projectKey);
  // what the organizers did not ask teams for is not shown, and never shown as missing
  const shown = (f: keyof typeof fields) => fields[f] !== "hidden";
  const askedLinks = shown("repoUrl") || shown("videoUrl") || shown("liveUrl");
  // the write-up, its images and the organizers' questions: a column of their own only when there is one of them
  const about = shown("description") || p.galleryUrls.length > 0 || p.answers.length > 0;
  const actor = await currentActor();
  const comments = listComments(actor, p.id);
  const canModerate = Boolean(actor?.roles.some((r) => r.eventId === event.id && r.role === "organizer"));
  const path = `/events/${event.slug}/projects/${p.id}`;
  // A signed-in member of this project's team: the page says so and points to where they manage it.
  const ours = (() => {
    if (!actor?.roles.some((r) => r.eventId === event.id && r.role === "participant")) return false;
    try {
      return getMyWork(actor, event.id).project?.id === p.id;
    } catch {
      return false;
    }
  })();
  // Once published, this project's own row of the published run: its place, score and ±, as the results page shows them.
  const results = event.resultsPublishedAt ? getPublishedResults(event.id) : null;
  const standing = (() => {
    if (!results?.published) return null;
    for (const t of results.tracks) {
      const i = t.rows.findIndex((r) => r.projectId === p.id);
      if (i >= 0) return { track: t, row: t.rows[i]!, place: competitionPlaces(t.rows)[i]!, pairwise: results.method === PAIRWISE_METHOD };
    }
    return null;
  })();
  // A move to another track the published run recorded, shown with the result it may have changed.
  const moves = results?.published ? results.trackMoves.filter((m) => m.projectId === p.id) : [];
  // FIG. 02: the other projects in its track, so a visitor can walk the track without going back to the gallery.
  // Once published, in the published order with each place; before that, by id (an order that ranks nothing).
  const trackmates: { id: string; title: string; team: string; place: number | null; joint: boolean }[] = (() => {
    if (standing) {
      const places = competitionPlaces(standing.track.rows);
      return standing.track.rows.map((r, i) => ({ id: r.projectId, title: r.title, team: r.teamName, place: places[i]!.place, joint: places[i]!.joint }));
    }
    try {
      return getGallery(event.id)
        .projects.filter((x) => x.trackId === p.track.id)
        .map((x) => ({ id: x.id, title: x.title, team: x.teamName, place: null, joint: false }));
    } catch {
      return [];
    }
  })();
  return (
    <PublicShell event={event} active="projects" signedInAs={actor?.name ?? null} links={actorNav(actor, event.id)}>
      <article className="pt-10">
        {ours ? (
          <p className="mb-8 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-xs border border-ink px-4 py-3 text-14">
            <span className="label-mono text-ink">Your team’s project</span>
            <span className="text-ink-2">This is how the public sees it.</span>
            <Link href={`/events/${event.slug}/my-project`} className="font-medium underline decoration-edge underline-offset-4 hover:decoration-ink sm:ml-auto">
              Open My project
            </Link>
          </p>
        ) : null}
        <div className="grid gap-8 md:grid-cols-[minmax(0,1fr)_min(40%,460px)] md:items-start md:gap-12 lg:gap-x-16">
          <header className="min-w-0 wrap-anywhere">
            <p className="label-mono text-ink-3">
              {p.id} / {p.track.name}
            </p>
            <h1 className="mt-3 font-display text-[40px] leading-[46px] md:text-[56px] md:leading-[60px]">{p.title}</h1>
            {p.summary ? <p className="mt-4 font-serif text-[22px] leading-8 text-ink-2">{p.summary}</p> : null}
            <p className="mt-4 text-15 text-ink-2">
              by <span className="font-semibold text-ink">{p.team.name}</span>
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
            {askedLinks ? (
              <div className="mt-6 flex flex-wrap gap-3">
                {p.repoUrl ? <LinkButton href={p.repoUrl} icon={<FolderGit2 className="size-4" aria-hidden />} label="Repository" /> : null}
                {p.videoUrl ? <LinkButton href={p.videoUrl} icon={<PlayCircle className="size-4" aria-hidden />} label="Demo video" /> : null}
                {p.liveUrl ? <LinkButton href={p.liveUrl} icon={<ExternalLink className="size-4" aria-hidden />} label="Live demo" /> : null}
                {!p.repoUrl && !p.videoUrl && !p.liveUrl ? <p className="text-14 text-ink-3">No links submitted.</p> : null}
              </div>
            ) : null}
            {/* Its result, where a visitor looks first: the published place, or a sealed slot until then. */}
            <section aria-labelledby="standing-title" className="mt-10 flex max-w-[560px] items-start gap-5 border-t-2 border-ink pt-4">
              {standing && standing.place.place !== null ? (
                <span
                  className={`w-16 shrink-0 text-center font-display text-64 leading-none tnum ${standing.place.place === 1 ? "text-accent-ink" : ""}`}
                  aria-hidden="true"
                >
                  {standing.place.place}
                </span>
              ) : (
                <span className="sealed h-16 w-16 shrink-0 rounded-xs border border-rule" aria-hidden="true" />
              )}
              <div className="min-w-0">
                <h2 id="standing-title" className="label-mono text-ink">
                  Published result
                </h2>
                {standing && standing.place.place !== null ? (
                  <>
                    <p className="mt-1.5 text-17 font-semibold">
                      {standing.place.joint ? "Joint " : ""}
                      {ordinal(standing.place.place)} in {standing.track.name}
                    </p>
                    <p className="text-14 text-ink-2 tnum">
                      {standing.row.score === null
                        ? ""
                        : standing.pairwise
                          ? `${Math.round(standing.row.score * 100)} % to win`
                          : `${standing.row.score.toFixed(2)}`}
                      {standing.row.se !== null
                        ? standing.pairwise
                          ? ` ± ${Math.max(1, Math.round(standing.row.se * 100))}`
                          : ` ± ${standing.row.se.toFixed(2)}`
                        : ""}
                      {` · ${standing.row.n} ${standing.pairwise ? (standing.row.n === 1 ? "judge" : "judges") : standing.row.n === 1 ? "review" : "reviews"}`}
                    </p>
                    {moves.map((m, i) => (
                      <p key={i} className="mt-1.5 text-13 text-flag wrap-anywhere">
                        <span className="tnum">{trackMoveWords(m)}</span>. Their reason: &ldquo;{m.reason}&rdquo;
                      </p>
                    ))}
                    <Link
                      href={`/events/${event.slug}/results#track-${standing.track.id}`}
                      className="mt-2 inline-block text-14 underline decoration-edge underline-offset-4 hover:decoration-ink"
                    >
                      See how it was worked out, among its track
                    </Link>
                  </>
                ) : event.resultsPublishedAt ? (
                  <p className="mt-1.5 text-14 text-ink-2">
                    Results are published, without a place for this project.{" "}
                    <Link href={`/events/${event.slug}/results`} className="underline decoration-edge underline-offset-4 hover:decoration-ink">
                      See the results page
                    </Link>
                    .
                  </p>
                ) : (
                  <>
                    <p className="mt-1.5 text-17 font-semibold">Sealed until the results are published</p>
                    <p className="text-14 text-ink-2">Scores stay with the judges and organizers until then.</p>
                  </>
                )}
              </div>
            </section>
          </header>
          <figure className="flex flex-col gap-2">
            <div className={`tile relative ${standing?.place.place === 1 ? "lit" : ""}`}>
              <div className="overflow-hidden rounded-xs border border-rule">
                {p.thumbnailUrl ? <ProjectImage src={p.thumbnailUrl} alt={`The team's picture of ${p.title}`} fallback={<Face id={p.id} />} /> : <Face id={p.id} />}
              </div>
              <span className="crop-marks" aria-hidden="true" />
            </div>
            <figcaption className="flex items-baseline justify-between gap-4 pt-1">
              <span className="label-mono text-ink">Fig. 01 — {p.thumbnailUrl ? "Its picture" : "Its face"}</span>
              <span className="text-13 text-ink-3">{p.thumbnailUrl ? "sent in by the team" : `drawn from ${p.id}`}</span>
            </figcaption>
            {canModerate && p.thumbnailUrl ? <TakeDownPicture projectId={p.id} path={`/events/${event.slug}/projects/${p.id}`} /> : null}
          </figure>
        </div>

        <div className="mt-12 grid gap-10 border-t border-rule pt-10 lg:grid-cols-[minmax(0,1fr)_min(40%,460px)] lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-12">
          {about ? (
            <div className="min-w-0 lg:max-w-[680px] [&>section:first-child]:mt-0 [&>section:first-child]:border-t-0 [&>section:first-child]:pt-0">
              {shown("description") ? (
                <>
                  <h2 className="text-20 font-semibold">About the project</h2>
                  {p.description ? (
                    <div className="mt-4 space-y-5 font-serif text-17 leading-7 whitespace-pre-line wrap-anywhere">{p.description}</div>
                  ) : (
                    <p className="mt-4 text-15 text-ink-3">{p.summary ? "The team wrote no description beyond the summary." : "The team wrote no description."}</p>
                  )}
                </>
              ) : null}
              {p.galleryUrls.length > 0 ? (
                <section className="mt-12 border-t border-rule pt-8" aria-labelledby="images-title">
                  <h2 id="images-title" className="text-20 font-semibold">
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
                  <h2 id="answers-title" className="text-20 font-semibold">
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
          ) : null}
          <aside className="flex flex-col gap-10 text-14 md:max-lg:grid md:max-lg:grid-cols-2 md:max-lg:items-start md:max-lg:gap-12 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            {/* The entry's record, in the status strip's mono voice: what it is, where it sits, when it came in. */}
            <section aria-labelledby="entry-title">
              <h2 id="entry-title" className="border-t-2 border-ink pt-2 label-mono text-ink">
                The entry
              </h2>
              <dl className="mt-1 divide-y divide-rule wrap-anywhere">
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-4 py-2.5">
                  <dt className="label-mono text-ink-3">Id</dt>
                  <dd className="font-mono text-13">{p.id}</dd>
                </div>
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-4 py-2.5">
                  <dt className="label-mono text-ink-3">Track</dt>
                  <dd>
                    <Link href={`/events/${event.slug}?track=${p.track.id}`} className="underline decoration-edge underline-offset-4 hover:decoration-ink">
                      {p.track.name}
                    </Link>
                  </dd>
                </div>
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-4 py-2.5">
                  <dt className="label-mono text-ink-3">Team</dt>
                  <dd>
                    {p.team.name} <span className="text-ink-3">· {p.team.members} {p.team.members === 1 ? "member" : "members"}</span>
                    {p.team.changedByOrganizersAt ? (
                      <span className="mt-0.5 block text-13 text-ink-2">
                        Changed by the organizers after submissions closed, {formatUtc(p.team.changedByOrganizersAt)}; the reason is in their audit log.
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-4 py-2.5">
                  <dt className="label-mono text-ink-3">Submitted</dt>
                  <dd className="tnum">{formatUtc(p.submittedAt)}</dd>
                </div>
              </dl>
            </section>
            {trackmates.length > 1 ? (
              <section aria-labelledby="track-title">
                <h2 id="track-title" className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t-2 border-ink pt-2">
                  <span className="label-mono whitespace-nowrap text-ink">Fig. 02 — Its track</span>
                  <span className="text-13 text-ink-3">
                    {p.track.name} · <span className="tnum">{trackmates.length}</span> projects{standing ? ", as published" : ""}
                  </span>
                </h2>
                <ol className="mt-2 flex flex-col">
                  {trackmates.map((m) => {
                    const here = m.id === p.id;
                    return (
                      <li key={m.id} className={here ? "lit" : undefined}>
                        <Link
                          href={`/events/${event.slug}/projects/${m.id}`}
                          aria-current={here ? "page" : undefined}
                          className="tile grid grid-cols-[3rem_4rem_minmax(0,1fr)] items-center gap-3 rounded-xs px-2 py-1.5 hover:bg-surface aria-[current=page]:bg-accent-tint"
                        >
                          {m.place !== null ? (
                            <span className={`flex flex-col font-display text-20 leading-none tnum ${m.place === 1 ? "text-accent-ink" : ""}`}>
                              {m.place}
                              {m.joint ? <span className="mt-1 font-mono text-12 leading-4 text-ink-3 uppercase"> joint</span> : null}
                            </span>
                          ) : (
                            <span className="font-mono text-12 text-ink-3">{m.id}</span>
                          )}
                          <span className="block overflow-hidden rounded-xs border border-rule">
                            <Face id={m.id} cols={32} rows={18} />
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-14 font-semibold">{m.title}</span>
                            <span className="block truncate text-13 text-ink-2">
                              {m.team}
                              {here ? <span className="text-accent-ink"> · this project</span> : null}
                            </span>
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
                <Link
                  href={`/events/${event.slug}?track=${p.track.id}`}
                  className="mt-2 ml-2 inline-block text-13 text-ink-2 underline decoration-edge underline-offset-4 hover:text-ink hover:decoration-ink"
                >
                  {p.track.name} in the gallery
                </Link>
              </section>
            ) : null}
          </aside>
          <section aria-labelledby="comments-title" className={`min-w-0 lg:max-w-[680px] pb-16 lg:col-start-1 ${about ? "border-t border-rule pt-8" : ""}`}>
            <h2 id="comments-title" className="flex items-baseline gap-2 text-20 font-semibold">
              Comments <span className="font-mono text-13 font-normal text-ink-3 tnum">{comments.filter((c) => !c.hidden).length}</span>
            </h2>
            {comments.length ? (
              <ol className="mt-5 flex flex-col border-t border-rule wrap-anywhere">
                {comments.map((c, n) => (
                  <li key={c.id} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3 border-b border-rule py-5 sm:grid-cols-[3rem_minmax(0,1fr)]">
                    <span className="pt-0.5 font-mono text-12 text-ink-3 tnum" aria-hidden="true">
                      {String(n + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      {/* a div, not a p: the delete, hide and unhide controls are forms, which a paragraph may not hold */}
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <bdi className="text-14 font-semibold">{c.author}</bdi>
                          {c.mine ? <span className="label-mono text-accent-ink">you</span> : null}
                          <span className="font-mono text-12 text-ink-3">{formatUtc(c.createdAt)}</span>
                        </span>
                        {(c.mine && !c.hidden) || canModerate ? (
                          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                            {c.mine && !c.hidden ? <DeleteOwnComment commentId={c.id} path={path} /> : null}
                            {canModerate ? <ModerateComment commentId={c.id} path={path} isHidden={Boolean(c.hidden)} /> : null}
                          </span>
                        ) : null}
                      </div>
                      {c.hidden ? (
                        <p className="sealed mt-2 rounded-xs border border-rule px-3 py-2 text-14 text-ink-2">
                          <span className="font-medium text-ink">Hidden by the organizers:</span> {c.hidden.reason}
                        </p>
                      ) : (
                        <p className="mt-1.5 font-serif text-17 leading-7 whitespace-pre-line">{c.body}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-15 text-ink-2">No comments yet.</p>
            )}
            <div className="mt-6">
              {actor ? (
                <CommentForm projectId={p.id} path={path} mine={comments.filter((c) => c.mine).map((c) => c.id)} />
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
        </div>
      </article>
    </PublicShell>
  );
}
