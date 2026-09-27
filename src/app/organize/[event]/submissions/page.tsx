import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { unauthorized } from "next/navigation";
import { Face } from "@/components/face";
import { Arrivals } from "@/components/figures/arrivals";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { formatUtc, isPast, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getOverview, getSubmissions, type SubmissionRow } from "@/server/dal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Submissions" };

const SHOWS = ["all", "needs", "drafts"] as const;
type Show = (typeof SHOWS)[number];

/** "1 Mar, 10:24": the whole event sits in one year and the column head says UTC, so each row drops both. */
const when = (iso: string) => formatUtc(iso).replace(/ \d{4},/, ",").replace(" UTC", "");

/** One cell per assigned review, filled when finished: the judges page's load figure, per project. */
function ReviewCells({ done, assigned }: { done: number; assigned: number }) {
  return (
    <span className="flex gap-[2px]" aria-hidden>
      {Array.from({ length: assigned }, (_, i) => (
        <span key={i} className={`h-2.5 w-[7px] ${i < done ? "bg-ink" : "border border-edge"}`} />
      ))}
    </span>
  );
}

export default async function SubmissionsPage({ params, searchParams }: PageProps<"/organize/[event]/submissions">) {
  const { event: key } = await params;
  const { show: showParam, track: trackParam } = await searchParams;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, rows, submitted, drafts } = guardPage(() => getSubmissions(actor, key));
  // The under-reviewed projects the overview still asks about, from its own decisions, so the two pages never disagree.
  const underOpen = new Set(
    guardPage(() => getOverview(actor, key)).decisions.flatMap((d) => (d.kind === "under_reviewed" && d.resolved === null ? [d.projectId] : [])),
  );
  const flagOf = (r: SubmissionRow) => (r.suspectedDuplicate ? "suspected duplicate" : underOpen.has(r.id) ? "under-reviewed" : null);

  const tracks = [...new Map(rows.map((r) => [r.trackName, rows.filter((x) => x.trackName === r.trackName).length])).entries()];
  const show: Show = SHOWS.find((s) => s === showParam) ?? "all";
  const track = typeof trackParam === "string" && tracks.some(([t]) => t === trackParam) ? trackParam : null;
  // Every chip counts what it would show next to the other filter, so no count promises rows the click does not bring.
  const inTrack = rows.filter((r) => !track || r.trackName === track);
  const needs = inTrack.filter((r) => flagOf(r) !== null).length;
  const draftsIn = inTrack.filter((r) => r.status === "draft").length;
  // A track chip counts what it would show under the chosen filter, so "Security 0" under Drafts says so before the click.
  const byShow = rows.filter((r) => show === "all" || (show === "needs" ? flagOf(r) !== null : r.status === "draft"));
  const shown = byShow.filter((r) => !track || r.trackName === track);
  const href = (s: Show, t: string | null) => {
    const q = new URLSearchParams();
    if (s !== "all") q.set("show", s);
    if (t) q.set("track", t);
    const qs = q.toString();
    return `/organize/${event.slug}/submissions${qs ? `?${qs}` : ""}`;
  };

  const arrivals = rows
    .filter((r) => r.status === "submitted" && r.submittedAt)
    .map((r) => ({ id: r.id, title: r.title, at: r.submittedAt!, flagged: Boolean(r.suspectedDuplicate && !r.duplicateOf && !r.mergedIn.length) }));
  const chip =
    "group inline-flex items-baseline gap-1.5 rounded-sm border border-edge px-3 py-1 text-13 hover:border-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface";
  const count = "tnum text-ink-3 group-aria-[current=page]:text-surface";

  return (
    <WorkShell eventName={event.name} eventHref={`/organize/${event.slug}`} tabs={organizerTabs(event.slug, "Submissions")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-24 font-semibold">Submissions</h1>
            <p className="mt-2 text-15 text-ink-2 tnum">
              {submitted} submitted · {plural(drafts, "draft")} · submissions {isPast(event.submissionsCloseAt) ? "closed" : "close"}{" "}
              {formatUtc(event.submissionsCloseAt)}
            </p>
          </div>
          <a
            href={`/api/events/${event.id}/export/projects.csv`}
            className="inline-flex h-9 items-center rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised"
          >
            Download projects.csv
          </a>
        </header>
        {arrivals.length ? (
          <figure className="flex flex-col gap-3 border-t-2 border-ink pt-3">
            <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <span className="label-mono text-ink">Fig. 01 — When they came in</span>
              <span className="text-12 text-ink-2">
                One cell per submitted project, in three-hour bins, UTC{arrivals.some((a) => a.flagged) ? "; orange: a suspected duplicate" : ""}. Point at a cell for its
                project.
              </span>
            </figcaption>
            {/* on a phone the figure scrolls sideways and opens at its right end, where the close is */}
            <div className="overflow-x-auto [direction:rtl]">
              <div className="min-w-[880px] [direction:ltr]">
                <Arrivals arrivals={arrivals} closeAt={event.submissionsCloseAt} />
              </div>
            </div>
          </figure>
        ) : null}
        {rows.length === 0 ? (
          <p className="rounded-sm border border-rule bg-surface p-6 text-15 text-ink-2">
            No projects yet. Teams appear here from their first saved draft; the public gallery shows only submitted ones.
          </p>
        ) : (
          <section aria-labelledby="list-title" className="flex flex-col gap-3">
            <h2 id="list-title" className="sr-only">
              Every project
            </h2>
            {/* Filters are plain links, so the list is server-rendered for every view and each view has its own address. */}
            <nav aria-label="Filter the list" className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center md:gap-x-5">
              <div className="flex flex-wrap gap-1.5">
                <Link href={href("all", track)} aria-current={show === "all" ? "page" : undefined} className={chip}>
                  All <span className={count}>{inTrack.length}</span>
                </Link>
                {needs ? (
                  <Link href={href("needs", track)} aria-current={show === "needs" ? "page" : undefined} className={chip}>
                    <span className="inline-block size-2 self-center bg-flag-bar" aria-hidden />
                    Needs a look <span className={count}>{needs}</span>
                  </Link>
                ) : (
                  <span className="inline-flex items-baseline gap-1.5 rounded-sm border border-dashed border-rule px-3 py-1 text-13 text-ink-3">
                    Nothing needs a look
                  </span>
                )}
                {draftsIn ? (
                  <Link href={href("drafts", track)} aria-current={show === "drafts" ? "page" : undefined} className={chip}>
                    Drafts <span className={count}>{draftsIn}</span>
                  </Link>
                ) : (
                  <span className="inline-flex items-baseline gap-1.5 rounded-sm border border-dashed border-rule px-3 py-1 text-13 text-ink-3">No drafts</span>
                )}
              </div>
              <span className="hidden h-5 w-px bg-rule md:block" aria-hidden />
              <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0">
                {tracks.map(([t]) => (
                  <Link key={t} href={href(show, track === t ? null : t)} aria-current={track === t ? "page" : undefined} className={`${chip} shrink-0 whitespace-nowrap`}>
                    {t} <span className={count}>{byShow.filter((r) => r.trackName === t).length}</span>
                  </Link>
                ))}
              </div>
            </nav>
            <div className="rounded-sm border border-rule bg-surface">
              <table className="w-full text-14 max-md:block">
                <thead className="max-md:hidden">
                  <tr className="border-b border-rule text-left text-13 text-ink-2">
                    <th className="px-3 py-2 font-medium" colSpan={2}>
                      Project
                    </th>
                    <th className="px-3 py-2 font-medium">Team</th>
                    <th className="px-3 py-2 font-medium">Submitted, UTC</th>
                    <th className="px-3 py-2 text-right font-medium">Reviews</th>
                  </tr>
                </thead>
                <tbody className="max-md:block">
                  {shown.length === 0 ? (
                    <tr className="max-md:block">
                      <td colSpan={5} className="px-4 py-6 text-15 text-ink-2 max-md:block">
                        {show === "drafts" ? "No drafts" : "Nothing needs a look"}
                        {track ? ` in ${track}` : ""}.{" "}
                        <Link href={href("all", track)} className="underline underline-offset-2 hover:text-ink">
                          Show all{track ? ` of ${track}` : ""}
                        </Link>
                      </td>
                    </tr>
                  ) : null}
                  {shown.map((r, n) => {
                    const flag = flagOf(r);
                    const merged = Boolean(r.duplicateOf);
                    const group = !track && (n === 0 || shown[n - 1].trackName !== r.trackName);
                    return (
                      <Fragment key={r.id}>
                        {group ? (
                          <tr className="border-b border-rule bg-sunken max-md:block">
                            <th colSpan={5} scope="colgroup" className="px-3 py-1.5 text-left font-normal max-md:block max-md:px-4">
                              <span className="label-mono text-ink-2">
                                {r.trackName} · {shown.filter((x) => x.trackName === r.trackName).length}
                              </span>
                            </th>
                          </tr>
                        ) : null}
                        {/* On phones each row stacks: face, title and reviews on one line, then the team and when it came in. */}
                        <tr
                          id={`row-${r.id}`}
                          data-project={r.id}
                          className={`border-b border-rule align-top last:border-b-0 max-md:grid max-md:grid-cols-[2rem_minmax(0,1fr)_auto] max-md:gap-x-3 max-md:gap-y-1 max-md:px-4 max-md:py-3 ${flag ? "max-md:shadow-[inset_3px_0_0_var(--flag-bar)]" : ""}`}
                        >
                          <td className={`w-12 py-2.5 pl-3 max-md:row-span-2 max-md:w-auto max-md:p-0 ${flag ? "md:shadow-[inset_3px_0_0_var(--flag-bar)]" : ""}`}>
                            <Face id={r.id} cols={32} rows={18} className={`mt-0.5 block h-[18px] w-8 ${merged ? "opacity-40" : ""}`} />
                          </td>
                          <td className="px-3 py-2.5 max-md:col-start-2 max-md:p-0">
                            {r.status === "submitted" ? (
                              <Link href={`/events/${event.slug}/projects/${r.id}`} className={`font-medium hover:underline ${merged ? "text-ink-2" : ""}`}>
                                {r.title}
                              </Link>
                            ) : (
                              <span className="font-medium">{r.title || "Untitled draft"}</span>
                            )}{" "}
                            <span className="font-mono text-12 text-ink-3">{r.id}</span>
                            {r.status === "draft" ? <span className="ml-2 rounded-sm border border-dashed border-edge px-1.5 text-12 text-ink-2">draft</span> : null}
                            {merged ? (
                              <span className="ml-2 text-12 text-ink-2">merged into {r.duplicateOf}</span>
                            ) : r.mergedIn.length ? (
                              <span className="ml-2 text-12 text-ink-2">{r.mergedIn.join(", ")} merged into this</span>
                            ) : null}
                            {flag ? (
                              <Link href={`/organize/${event.slug}#decisions-title`} className="mt-0.5 block text-12 text-flag underline underline-offset-2 md:ml-2 md:inline">
                                {flag}: decide on the overview
                              </Link>
                            ) : null}
                          </td>
                          <td className="px-3 py-2.5 max-md:col-start-2 max-md:row-start-2 max-md:p-0 max-md:text-13 max-md:text-ink-2">
                            {r.teamName} <span className="text-13 text-ink-3">· {plural(r.members, "member")}</span>
                            {r.submittedAt ? <span className="mt-0.5 block font-mono text-12 text-ink-3 md:hidden">{when(r.submittedAt)}</span> : null}
                          </td>
                          <td className="px-3 py-2.5 font-mono text-12 whitespace-nowrap text-ink-2 max-md:hidden">{r.submittedAt ? when(r.submittedAt) : "–"}</td>
                          <td className="px-3 py-2.5 text-right tnum max-md:col-start-3 max-md:row-start-1 max-md:p-0">
                            {r.reviewsAssigned ? (
                              <span className="flex items-center justify-end gap-2.5">
                                <ReviewCells done={r.reviewsDone} assigned={r.reviewsAssigned} />
                                <span className="whitespace-nowrap">
                                  {r.reviewsDone} of {r.reviewsAssigned}
                                </span>
                              </span>
                            ) : (
                              <span className="text-ink-3">–</span>
                            )}
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </WorkShell>
  );
}
