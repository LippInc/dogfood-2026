import type { Metadata } from "next";
import Link from "next/link";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { HashGlyph } from "@/components/figures/hash-glyph";
import { LeniencyStrip } from "@/components/figures/leniency-strip";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import {
  currentActor,
  getOverview,
  type AuditLine,
  type Stage,
  PULL_SHOWN_WITHIN,
} from "@/server/dal";
import { CopyButton } from "./judges/forms";
import { Decisions, PublishPanel } from "./decisions";
import { exportHref } from "@/lib/export-href";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Overview" };

// The organizer's overview in three levels (DESIGN.md): the event's pipeline as a
// context strip, the decisions and the Publish panel as the one focal point (the
// only raised panels on the page), and three open figures on the page's own
// ground, each a number, a picture of it and one line, with the details a click
// away. The figures sit under a ruled head, like the gallery's Field.

const EXPORTS = [
  "scores.csv",
  "projects.csv",
  "normalized.csv",
  "audit.csv",
  "event.json",
];

function Pipeline({ stages }: { stages: Stage[] }) {
  const reached = stages.filter((s) => s.done).length;
  return (
    <nav
      aria-label="Event pipeline"
      className="border-b border-rule bg-surface"
    >
      {/* Phones scroll the stations sideways in one row; wider screens show all ten. */}
      <ol className="mx-auto flex max-w-[1440px] overflow-x-auto px-4 pt-5 pb-4 sm:grid sm:grid-cols-5 sm:gap-y-5 sm:overflow-visible lg:grid-cols-10 lg:px-8">
        {stages.map((s, i) => {
          const done = i < reached;
          return (
            <li
              key={s.no}
              className="relative w-[132px] shrink-0 pt-5 pr-3 sm:w-auto"
              aria-current={s.current ? "step" : undefined}
            >
              {/* the line: ink through the stages reached, a hairline after */}
              <span
                aria-hidden
                className={`absolute top-[4px] right-0 left-0 h-[2px] ${done ? "bg-ink" : "bg-rule"}`}
              />
              {/* the station: filled when done, orange when it needs you, open ahead */}
              <span
                aria-hidden
                className={`absolute top-0 left-0 size-[10px] ${
                  s.open
                    ? "bg-flag-bar"
                    : done
                      ? "bg-ink"
                      : s.current
                        ? "border-2 border-ink bg-surface"
                        : "border-[1.5px] border-edge bg-surface"
                }`}
              />
              <p className="flex items-baseline gap-1.5">
                <span className="font-mono text-12 text-ink-3">{s.no}</span>
                <span
                  className={`truncate text-14 ${s.current || s.open ? "font-semibold text-ink" : done ? "text-ink" : "text-ink-2"}`}
                >
                  {s.name}
                </span>
              </p>
              <p
                className={`mt-0.5 truncate text-12 ${s.open ? "font-medium text-flag" : "text-ink-2"}`}
              >
                {s.state}
              </p>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function AuditSentence({ line }: { line: AuditLine }) {
  return (
    <>
      {line.parts.map((p, i) =>
        p.mono ? (
          <span key={i} className="font-mono text-12 text-ink-2">
            {p.text}
          </span>
        ) : p.strong ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** One of the three open figures: a ruled head with its FIG. number, then the figure. */
function Figure({
  id,
  no,
  title,
  aside,
  children,
}: {
  id: string;
  no: string;
  title: string;
  aside: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-4 border-t-2 border-ink pt-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={id} className="label-mono text-ink">
          Fig. {no} — {title}
        </h2>
        <span className="text-13 text-ink-2">{aside}</span>
      </div>
      {children}
    </section>
  );
}

const linkCls = "text-13 underline underline-offset-4 hover:text-ink";

export default async function OverviewPage({
  params,
}: PageProps<"/organize/[event]">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const o = guardPage(() => getOverview(actor, key));
  const { event, judges, normalization: nz } = o;
  const origin = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const faceIds = new Set(
    o.decisions.flatMap((d) =>
      d.kind === "flat_judge"
        ? d.evidence.map((e) => e.projectId)
        : d.kind === "duplicate"
          ? d.copies.map((c) => c.id)
          : d.kind === "coin_flip_judge"
            ? []
            : [d.projectId],
    ),
  );
  const faces = Object.fromEntries(
    [...faceIds].map((id) => [
      id,
      <Face
        key={id}
        id={id}
        cols={32}
        rows={18}
        className="block h-[18px] w-8"
      />,
    ]),
  );
  const reminders = judges.unfinished
    .map(
      (j) =>
        `Hi ${j.name}, ${j.assigned - j.done} of your ${plural(j.assigned, "review")} for ${event.name} ${j.assigned - j.done === 1 ? "is" : "are"} still open. Your console: ${origin}/judge/${event.slug}`,
    )
    .join("\n\n");
  const runLabel = event.resultsPublishedAt ? "published run" : "preview";

  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Overview")}
      tools={
        <>
          <LiveRefresh />
          <a
            href={exportHref(event.id, "scores.csv")}
            className="inline-flex h-8 items-center rounded-sm border border-edge px-3 text-13 font-medium hover:bg-raised"
          >
            Export CSV
          </a>
        </>
      }
      person={actor.name}
      role="Organizer"
      flush
    >
      <h1 className="sr-only">{event.name}: overview</h1>
      <Pipeline stages={o.pipeline} />
      <div className="mx-auto flex max-w-[1440px] flex-col gap-10 px-4 py-6 lg:px-8">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-3">
          <Decisions
            eventSlug={event.slug}
            decisions={o.decisions}
            faces={faces}
            published={Boolean(event.resultsPublishedAt)}
          />
          <PublishPanel
            eventSlug={event.slug}
            open={o.open}
            total={o.decisions.length}
            publishedAt={event.resultsPublishedAt}
            submissionsCloseAt={o.submissionsOpenUntil}
            pairwise={o.pairwise !== null}
            vote={o.vote}
          />
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-10 lg:grid-cols-3">
          <Figure
            id="judges-card"
            no="02"
            title="Judges"
            aside={
              <Link href={`/organize/${event.slug}/judges`} className={linkCls}>
                All {judges.total}
              </Link>
            }
          >
            <p className="flex items-baseline gap-2">
              <span className="text-38 leading-none font-semibold tnum">
                {judges.finished}
              </span>
              <span className="text-14 text-ink-2 tnum">
                of {judges.total} finished
              </span>
            </p>
            {judges.segments.length ? (
              <figure className="flex flex-col gap-2">
                <div className="flex gap-[3px]" aria-hidden>
                  {judges.segments.map((s, i) => (
                    <span
                      key={i}
                      className={`h-4 flex-1 border ${s === "done" ? "border-ink bg-ink" : s === "open" ? "border-edge bg-transparent" : "border-rule bg-sunken"}`}
                    />
                  ))}
                </div>
                <figcaption className="flex flex-wrap justify-between gap-x-4 text-12 text-ink-2 tnum">
                  <span>One square per judge, filled when finished</span>
                  <span>
                    {judges.reviewsDone} of {plural(judges.reviewsAssigned, "review")} in
                  </span>
                </figcaption>
              </figure>
            ) : null}
            {judges.unfinished.length ? (
              <>
                <ul className="divide-y divide-rule border-y border-rule">
                  {judges.unfinished.slice(0, 3).map((j) => (
                    <li
                      key={j.id}
                      className="flex items-baseline justify-between gap-3 py-2 text-14"
                    >
                      <span className="font-medium">{j.name}</span>
                      <span className="truncate text-13 text-ink-2">
                        {j.tracks} · {j.done} of {j.assigned}
                      </span>
                    </li>
                  ))}
                </ul>
                <div>
                  <CopyButton
                    text={reminders}
                    label={`Copy ${judges.unfinished.length} ${judges.unfinished.length === 1 ? "reminder" : "reminders"}`}
                  />
                </div>
              </>
            ) : (
              <p className="text-14 text-ink-2">
                {judges.reviewsAssigned
                  ? "Every assigned review is in."
                  : "No reviews assigned yet."}
              </p>
            )}
          </Figure>

          {o.pairwise ? (
            <Figure id="norm-card" no="03" title="Ranking" aside={runLabel}>
              <p className="flex items-baseline gap-2">
                <span className="text-38 leading-none font-semibold tnum">
                  {o.pairwise.placed}
                </span>
                <span className="text-14 text-ink-2 tnum">
                  of {o.pairwise.total} placed
                </span>
              </p>
              <p className="text-13 leading-5 text-ink-2">
                Judged pairwise: each judge places their own projects ({o.pairwise.total} in all; the first in each track needs no question).{" "}
                {plural(o.pairwise.answers, "answer")} so far, plus the order of every judge&rsquo;s earlier scores.{" "}
                {o.pairwise.left?.measured && o.pairwise.fresh?.measured
                  ? `Between two equal projects the one on the left wins ${Math.round(o.pairwise.left.share * 100)} % and the one a judge has just opened ${Math.round(o.pairwise.fresh.share * 100)} %; the ranking takes both pulls out.`
                  : `Too few answers yet to measure the pull of the left side and of the project just opened (each is shown once it is known within ${PULL_SHOWN_WITHIN} points); until then the fit assumes almost none.`}
              </p>
              <Link href={`/organize/${event.slug}/results`} className={`${linkCls} self-start`}>
                Show the working
              </Link>
            </Figure>
          ) : (
            <Figure id="norm-card" no="03" title="Normalization" aside={runLabel}>
              {nz.ranked ? (
                <>
                  <p className="flex items-baseline gap-2">
                    <span className="text-38 leading-none font-semibold tnum">
                      {nz.k === null ? "0.00" : `±${nz.maxLeniency.toFixed(2)}`}
                    </span>
                    <span className="text-14 text-ink-2">
                      {nz.k === null
                        ? "no judge leniency found"
                        : "the most any judge moves a score"}
                    </span>
                  </p>
                  <LeniencyStrip
                    points={nz.points}
                    label={`Leniency of ${plural(nz.points.length, "judge")}: plain averages against what the data supports`}
                  />
                  <p className="text-13 leading-5 text-ink-2">
                    {nz.k === null
                      ? "The scores show no steady difference between lenient and harsh judges, so the engine corrects nothing and ranks by the plain mean."
                      : `${nz.minReviews} to ${nz.maxReviews} reviews per judge is too few to tell a lenient judge from a strong batch: at k = ${nz.k.toFixed(1)} half a judge's tilt counts after ${plural(Math.round(nz.k), "review")}, so the engine keeps at most ${Math.round(nz.keptShare * 100)} % of anyone's.`}
                    {nz.excludedNames.length
                      ? ` Left out: ${nz.excludedNames.join(", ")}.`
                      : ""}
                  </p>
                  <Link href={`/organize/${event.slug}/results`} className={`${linkCls} self-start`}>
                    Show the working
                  </Link>
                </>
              ) : (
                <p className="text-14 text-ink-2">
                  Nothing to normalize until reviews are finished.
                </p>
              )}
            </Figure>
          )}

          <Figure
            id="audit-card"
            no="04"
            title="Audit log"
            aside={
              <Link href={`/organize/${event.slug}/audit`} className={linkCls}>
                Full log
              </Link>
            }
          >
            {o.audit.length ? (
              <ol className="flex flex-col">
                {o.audit.map((line, i) => {
                  const older = o.audit[i + 1];
                  // a solid link when the next row shown is the row just before; dotted over rows not shown here
                  const link = older ? (line.id - older.id === 1 ? "solid" : "dotted") : null;
                  return (
                    <li
                      key={line.id}
                      className="grid grid-cols-[40px_minmax(0,1fr)] gap-3 pb-4"
                    >
                      <span aria-hidden className="relative flex flex-col items-start pt-[3px]">
                        <HashGlyph hash={line.hash} digits={8} className="relative z-[1] bg-bg pb-1" />
                        {link ? (
                          <span
                            className={`absolute top-5 -bottom-1 left-[15px] border-l-2 ${link === "solid" ? "border-ink-3" : "border-dotted border-edge"}`}
                          />
                        ) : null}
                      </span>
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-mono text-12 text-ink-3">
                          #{line.id} ·{" "}
                          {formatUtc(line.at)
                            .replace(/ \d{4},/, "")
                            .replace(" UTC", "")}
                        </span>
                        <span className="text-14 leading-5 wrap-anywhere">
                          <AuditSentence line={line} />
                          {/[.!?]”?$/.test(line.parts.at(-1)?.text ?? "") ? "" : "."}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="text-14 text-ink-2">
                Nothing logged for this event yet.
              </p>
            )}
            <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-3">
              <p className="text-12 text-ink-2">Take it out, at any stage</p>
              <div className="flex flex-wrap gap-2">
                {EXPORTS.map((f) => (
                  <a
                    key={f}
                    href={exportHref(event.id, f)}
                    className="inline-flex h-7 items-center rounded-sm border border-edge bg-surface px-2 font-mono text-12 hover:bg-raised"
                  >
                    {f}
                  </a>
                ))}
              </div>
            </div>
          </Figure>
        </div>
      </div>
    </WorkShell>
  );
}
