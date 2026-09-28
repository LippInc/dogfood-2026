import type { Metadata } from "next";
import Link from "next/link";
import { notFound, unauthorized } from "next/navigation";
import { Deadline } from "@/components/deadline";
import { Face } from "@/components/face";
import { ProjectImage } from "@/components/project-cover";
import { PublicShell } from "@/components/shell/public-shell";
import { Badge } from "@/components/ui/badge";
import { formatUtc, isPast } from "@/lib/format";
import { actorNav, currentActor, getMyWork, myRecords, NotFoundError, PAIRWISE_METHOD, type MyWork } from "@/server/dal";
import { openOwnRecord } from "../../../records/actions";
import { HandedIn } from "./handed-in";
import { ProjectForm, type FormProject } from "./project-form";
import { StartTeam, TeamPanel } from "./team-panel";

type TeamFeedback = NonNullable<MyWork["feedback"]>;

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
  const formProject: FormProject | null = project
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
    : null;
  const trackName = work.tracks.find((t) => t.id === project?.trackId)?.name ?? null;
  const recordButton = "inline-flex h-10 items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-surface";

  const side = (
    <>
      {open ? (
        <section aria-labelledby="deadline-title">
          <h2 id="deadline-title" className="label-mono text-ink-2">
            Submissions close
          </h2>
          <div className="mt-3">
            <Deadline iso={event.submissionsCloseAt} utcLabel={closeLabel} />
          </div>
        </section>
      ) : !work.feedback && project?.status === "submitted" ? (
        // After the close the date is in the stages strip and the sheet; what the team waits for is the results.
        <section aria-labelledby="next-title">
          <h2 id="next-title" className="label-mono text-ink-2">
            What comes next
          </h2>
          <p className="mt-3 text-15 text-ink">
            {event.judgingCloseAt && !isPast(event.judgingCloseAt) ? `Judges review until ${formatUtc(event.judgingCloseAt)}.` : "The judges are reviewing."}
          </p>
          <p className="mt-2 text-14 text-ink-2">
            When the organizers publish results, your place{trackName ? ` in ${trackName}` : ""} and every review of your project, judges unnamed,
            appear at the top of this page.
          </p>
        </section>
      ) : null}
      {team ? <TeamPanel team={team} eventSlug={event.slug} open={open} me={actor.userId} /> : null}
    </>
  );

  return (
    <PublicShell event={event} active="none" signedInAs={actor.name} links={actorNav(actor, event.id)}>
      <div className="grid gap-8 pt-10 pb-8 md:grid-cols-[minmax(0,1fr)_280px] md:items-end lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 wrap-anywhere">
          <p className="label-mono text-ink-3">{team ? `Team ${team.name}` : open ? "No team yet" : "No team"}</p>
          <h1 className="mt-2 font-display text-[40px] leading-[46px] md:text-[52px] md:leading-[58px]">Your project</h1>
          {project?.title ? (
            <p className="mt-3 font-serif text-24 leading-8">
              {project.title}
              {project.summary ? <span className="text-ink-2"> — {project.summary}</span> : null}
            </p>
          ) : null}
        </div>
        {project ? (
          <figure className="min-w-0">
            <figcaption className="label-mono text-ink-3">Fig. 01 — in the gallery</figcaption>
            <div className="lit mt-2 overflow-hidden rounded-xs border border-rule">
              {project.thumbnailUrl ? (
                <ProjectImage src={project.thumbnailUrl} alt="" fallback={<Face id={project.id} className="block aspect-video w-full" />} />
              ) : (
                <Face id={project.id} className="block aspect-video w-full" />
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              {project.status === "submitted" ? (
                <Badge variant="ok">Submitted {formatUtc(project.submittedAt, { time: false })}</Badge>
              ) : (
                <Badge>Draft</Badge>
              )}
              <span className="font-mono text-12 text-ink-3">{project.id}</span>
            </div>
          </figure>
        ) : null}
      </div>
      <Stages work={work} />
      {/* On a phone the side column, and the invite link in it, comes after the whole form; a captain still alone on the team gets a way down to it. */}
      {open && team?.role === "captain" && team.inviteCode && team.members.length === 1 ? (
        <p className="mb-6 text-14 text-ink-2 lg:hidden">
          Only you on the team so far.{" "}
          <a href="#team-title" className="font-medium text-ink underline underline-offset-4">
            Invite teammates with your link ↓
          </a>
        </p>
      ) : null}
      {work.feedback ? (
        <section aria-labelledby="feedback-title" className="mb-10 border-b border-rule py-10">
          <p className="label-mono text-accent-ink">Results are published</p>
          <div className="mt-4 grid gap-8 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)] md:items-end lg:grid-cols-[minmax(0,1fr)_400px]">
            <h2 id="feedback-title" className="flex flex-wrap items-end gap-x-4 gap-y-1">
              {work.feedback.place !== null ? (
                <>
                  <span className="flex flex-col">
                    <span className="label-mono text-ink-3">Place</span>{" "}
                    <span className="font-display text-[88px] leading-[80px] tnum">{work.feedback.place}</span>
                  </span>{" "}
                  <span className="pb-1.5 text-24 font-semibold">in {work.feedback.trackName}</span>
                </>
              ) : (
                <span className="text-24 font-semibold">Not ranked</span>
              )}
            </h2>
            {work.feedback.score !== null ? <ScoreFigure feedback={work.feedback} pairwise={pairwise} /> : null}
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
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
          <p className="mt-8 max-w-[760px] text-15 text-ink-2">
            {pairwise
              ? "Your place comes from the judges’ answers to “which of these two is better?”, with any scores given before the event switched to that way of judging counted as the order they imply. Your win % is your chance to beat an average project of your track. The written reviews below, judges unnamed, are the ones given as scores."
              : "Every review of your project, judges unnamed. The score is the reviews’ weighted average, adjusted for each judge’s leniency across the event."}
          </p>
          <ReviewCards feedback={work.feedback} />
        </section>
      ) : null}
      {!team ? (
        <StartTeam eventSlug={event.slug} open={open} closedLabel={formatUtc(event.submissionsCloseAt)} published={Boolean(event.resultsPublishedAt)} />
      ) : open ? (
        <ProjectForm
          eventSlug={event.slug}
          open={open}
          tracks={work.tracks}
          questions={work.questions}
          project={formProject}
          side={side}
          face={<Face id={project?.id ?? `team-${team.id}`} className="block aspect-video w-full" />}
        />
      ) : (
        <div className="grid gap-10 lg:grid-cols-[minmax(0,680px)_320px] lg:justify-between">
          <HandedIn
            eventSlug={event.slug}
            closedAt={event.submissionsCloseAt}
            project={formProject}
            trackName={trackName}
            questions={work.questions}
          />
          <aside className="flex flex-col gap-8 lg:sticky lg:top-6 lg:self-start">{side}</aside>
        </div>
      )}
    </PublicShell>
  );
}

/**
 * Where the team stands in the event, in five steps, from the event's own dates and
 * the team's own project: what is done, what is happening now, what comes next.
 */
function Stages({ work }: { work: MyWork }) {
  const { event, team, project, open } = work;
  const published = Boolean(event.resultsPublishedAt);
  const short = (iso: string) => formatUtc(iso, { time: false });
  const submitted = project?.status === "submitted";
  // After the close a step the team never reached is missed, not "now": it can no longer happen.
  const steps: { name: string; state: string; done: boolean; missed: boolean }[] = [
    {
      name: "Team",
      state: team ? `${team.members.length} ${team.members.length === 1 ? "member" : "members"}` : open ? "not started" : "no team",
      done: Boolean(team),
      missed: !team && !open,
    },
    {
      name: "Project",
      state: !project ? (open ? "not started" : "none handed in") : submitted ? `submitted ${short(project.submittedAt ?? event.submissionsCloseAt)}` : open ? "draft" : "draft, never submitted",
      done: submitted,
      missed: !submitted && !open,
    },
    { name: open ? "Submissions close" : "Submissions closed", state: short(event.submissionsCloseAt), done: !open, missed: false },
    {
      name: "Judging",
      state: published
        ? "finished"
        : !open
          ? event.judgingCloseAt && !isPast(event.judgingCloseAt)
            ? `until ${short(event.judgingCloseAt)}`
            : "in progress"
          : "after the close",
      done: published,
      missed: false,
    },
    { name: "Results", state: published ? `published ${short(event.resultsPublishedAt!)}` : "not yet", done: published, missed: false },
  ];
  const now = steps.findIndex((s) => !s.done && !s.missed);
  return (
    <nav aria-label="Where your team stands" className="mb-2 border-y border-rule py-5">
      <ol className="flex flex-col gap-3 sm:grid sm:grid-cols-5 sm:gap-0">
        {steps.map((s, i) => (
          <li key={s.name} className="relative pl-4 sm:pt-4 sm:pr-3 sm:pl-0" aria-current={i === now ? "step" : undefined}>
            <span
              aria-hidden
              className={`absolute top-0 bottom-0 left-0 w-[3px] sm:right-0 sm:bottom-auto sm:h-[3px] sm:w-auto ${
                s.done ? "bg-ink" : i === now ? "bg-accent" : s.missed ? "border-l-[3px] border-dashed border-edge sm:border-t-[3px] sm:border-l-0" : "bg-rule"
              }`}
            />
            {i === now ? <span aria-hidden className="absolute top-0 -left-[3px] size-[9px] bg-accent sm:-top-[3px] sm:left-0" /> : null}
            <p className="flex items-baseline gap-2 sm:block">
              <span className="font-mono text-12 text-ink-3 sm:block">{String(i + 1).padStart(2, "0")}</span>
              <span className={`text-14 ${i === now ? "font-semibold" : s.done ? "" : "text-ink-2"}`}>{s.name}</span>
            </p>
            <p className="text-12 text-ink-2">
              {s.state}
              <span className="sr-only">{s.done ? ", done" : i === now ? ", now" : s.missed ? ", missed" : ", to come"}</span>
            </p>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The axis every review and the score share: the rubric's range as the reviews show it, 1 to 5 at the least. */
function axisOf(feedback: TeamFeedback): [number, number] {
  const values = feedback.reviews.flatMap((r) => r.values.map((v) => v.value));
  return [Math.min(1, ...values), Math.max(5, ...values)];
}

/** FIG. 02: the published score on its scale, with its ± drawn as a bar. Numbers from the published run only. */
function ScoreFigure({ feedback, pairwise }: { feedback: TeamFeedback; pairwise: boolean }) {
  const score = feedback.score!;
  const se = feedback.se;
  const [lo, hi] = pairwise ? [0, 1] : axisOf(feedback);
  const W = 400;
  const pad = 14;
  const x = (v: number) => pad + ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (W - 2 * pad);
  const ticks = pairwise ? [0, 0.25, 0.5, 0.75, 1] : Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  const label = (v: number) => (pairwise ? `${Math.round(v * 100)}%` : String(v));
  const text = pairwise
    ? `wins ${Math.round(score * 100)} %${se !== null ? ` ± ${Math.max(1, Math.round(se * 100))}` : ""} against the track’s average`
    : `score ${score.toFixed(2)}${se !== null ? ` ± ${se.toFixed(2)}` : ""}`;
  return (
    <figure className="min-w-0">
      <figcaption className="label-mono text-ink-3">Fig. 02 — {pairwise ? "your win %" : "your score"}, with its margin of error (±)</figcaption>
      <svg viewBox={`0 0 ${W} 58`} className="mt-3 block h-auto w-full max-w-[420px]" role="img" aria-label={text}>
        <line x1={pad} x2={W - pad} y1={30} y2={30} stroke="var(--edge)" strokeWidth={1} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={25} y2={35} stroke="var(--edge)" strokeWidth={1} />
            <text x={x(t)} y={54} textAnchor="middle" fontSize={11} fill="var(--ink-3)" fontFamily="var(--font-mono)">
              {label(t)}
            </text>
          </g>
        ))}
        {se !== null ? (
          <g stroke="var(--ink)" strokeWidth={2}>
            <line x1={x(score - se)} x2={x(score + se)} y1={30} y2={30} />
            <line x1={x(score - se)} x2={x(score - se)} y1={23} y2={37} />
            <line x1={x(score + se)} x2={x(score + se)} y1={23} y2={37} />
          </g>
        ) : null}
        <rect x={x(score) - 6} y={24} width={12} height={12} fill="var(--accent)" stroke="var(--ink)" strokeWidth={1} />
      </svg>
      <p className="mt-1 text-15 text-ink-2">
        {pairwise ? (
          <>
            wins <span className="font-semibold text-ink tnum">{Math.round(score * 100)} %</span>
            {se !== null ? ` ± ${Math.max(1, Math.round(se * 100))}` : ""} against the track&rsquo;s average
          </>
        ) : (
          <>
            score <span className="font-semibold text-ink tnum">{score.toFixed(2)}</span>
            {se !== null ? ` ± ${se.toFixed(2)}` : ""}
          </>
        )}
      </p>
    </figure>
  );
}

/** Every review as a small score sheet: one row of cells per criterion, then the judge's words. */
function ReviewCards({ feedback }: { feedback: TeamFeedback }) {
  const [lo, hi] = axisOf(feedback);
  const cells = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
  return (
    <ol className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {feedback.reviews.map((r, i) => (
        <li key={i} className={`flex flex-col rounded-sm border border-rule bg-surface p-5 wrap-anywhere ${r.counted ? "" : "opacity-70"}`}>
          <p className="flex items-baseline justify-between gap-3">
            <span className="label-mono text-ink-2">Review {i + 1}</span>
            <span className="text-20 font-semibold tnum">
              <span className="sr-only">total </span>
              {r.total.toFixed(2)}
            </span>
          </p>
          <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-13">
            {r.values.map((v) => (
              <div key={v.label} className="contents">
                <dt className="text-ink-2">{v.label}</dt>
                <dd aria-hidden className="flex gap-[3px]">
                  {cells.map((c) => (
                    <span key={c} className={`h-2 flex-1 rounded-[1px] border ${c <= v.value ? "border-ink bg-ink" : "border-edge"}`} />
                  ))}
                </dd>
                <dd className="text-right font-medium tnum">{v.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 border-t border-rule pt-4 font-serif text-17 leading-7">
            {r.feedback || <span className="text-ink-3">No written feedback.</span>}
          </p>
          {r.counted ? null : (
            <p className="mt-2 text-12 text-ink-2">Not counted: this judge gave the same scores to every project, so the organizers left them out.</p>
          )}
        </li>
      ))}
    </ol>
  );
}
