import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Fragment } from "react";
import { unauthorized } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DetailRows, DetailToggle } from "@/components/detail-row";
import { formatUtc, plural } from "@/lib/format";
import { openWork } from "@/lib/judge-open-work";
import { reminderText } from "@/lib/judge-reminder";
import { guardPage } from "@/lib/page-guard";
import { LeniencyAxis, LeniencyRow, leniencySpan } from "@/components/figures/leniency-row";
import { currentActor, emailIsOn, getAssignments, getJudges, getNormalization, judgingModeOf, publicUrl, type JudgeRow, type JudgeStanding } from "@/server/dal";
import { removeJudgeAction } from "./actions";
import { WithReason } from "../decisions";
import { BatchInviteForm, ByHandForm, CopyButton, EmailReminder, InviteForm, RevokeInviteForm, RunForm, TracksForm } from "./forms";

export const dynamic = "force-dynamic";

/** Signed to two decimals; a value that rounds to zero shows as 0.00, never −0.00. */
const signed = (v: number) => (Math.abs(v) < 0.005 ? "0.00" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(2)}`);

/** On phones the column head is gone, so the cell names itself. */
const PhoneLabel = () => <span className="text-ink-3 md:hidden">Leniency: </span>;

/** One judge's leniency in the table: their plain tilt and what the engine takes off, drawn on the shared axis. */
function Leniency({ s, k, span }: { s: JudgeStanding | undefined; k: number | null; span: number }) {
  if (!s || s.nAll === 0) return <p className="text-13 text-ink-3">
        <PhoneLabel />
        no finished review
      </p>;
  if (s.excluded) return <p className="text-13 text-flag">
        <PhoneLabel />
        left out: nothing counted
      </p>;
  if (k === null) return <p className="text-13 text-ink-3">
        <PhoneLabel />
        not corrected yet
      </p>;
  return (
    <div className="flex flex-col gap-1">
      <LeniencyRow tilt={s.tilt} leniency={s.leniency} se={null} span={span} />
      <p className="text-12 whitespace-nowrap text-ink-2 tnum">
        <PhoneLabel />
        {s.tilt === null ? "" : `tilt ${signed(s.tilt)} · `}takes off <span className="text-ink">{signed(s.leniency)}</span>
      </p>
    </div>
  );
}
export const metadata: Metadata = { title: "Judges" };

/**
 * Where a judge sits in the table: what needs the organizer first, then the judges who have not started (reviews
 * assigned, nothing saved), then open work, then done.
 */
const groupOf = (j: JudgeRow) => (j.excluded || (j.flat && !j.override) ? 0 : j.notStarted ? 1 : j.pending > 0 ? 2 : j.assigned > 0 ? 3 : 4);
const FINISHED = 3;
// Open work while judging runs, and only unfinished once results are published; likewise not started, and never started.
const groupNames = (published: boolean) => ["Flagged", published ? "Never started" : "Not started", openWork(0, published).group, "All finished", "Nothing assigned"];

/** The table's two views, each with its own address: every judge, or only those who have not started. */
const NOT_STARTED = "not-started";

export default async function JudgesPage({ params, searchParams }: PageProps<"/organize/[event]/judges">) {
  const { event: key } = await params;
  const { show } = await searchParams;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, tracks, judges: byName, invites, removed } = guardPage(() => getJudges(actor, key));
  // Flagged first, then not started, then the most open reviews, then finished; by name inside each group (the sort is stable).
  const everyone = [...byName].sort((x, y) => groupOf(x) - groupOf(y) || (groupOf(x) === 2 ? y.pending - x.pending : 0));
  const idle = everyone.filter((j) => j.notStarted);
  const onlyIdle = show === NOT_STARTED;
  const judges = onlyIdle ? idle : everyone;
  const grouped = new Set(judges.map(groupOf)).size > 1;
  const a = getAssignments(actor, event.id);
  const published = Boolean(event.resultsPublishedAt);
  const groups = groupNames(published);
  const origin = publicUrl();
  const console_ = `${origin}/judge/${event.slug}`;
  // the same words the portal mails with "Email reminder" (lib/judge-reminder.ts)
  const nudge = (j: JudgeRow) => reminderText(j, event.name, console_);
  // with SMTP_URL set, the Not started view can also mail the reminders; without it, only the copy buttons, as before
  const mailable = emailIsOn() && !published;
  const viewHref = (v: string | null) => `/organize/${event.slug}/judges${v ? `?show=${v}` : ""}`;
  const chip =
    "group inline-flex items-baseline gap-1.5 rounded-sm border border-edge px-3 py-1 text-13 hover:border-ink aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-surface";
  const chipCount = "tnum text-ink-3 group-aria-[current=page]:text-surface";
  const assigned = everyone.reduce((s, j) => s + j.assigned, 0);
  const finished = everyone.reduce((s, j) => s + j.done, 0);
  const openInvites = invites.filter((i) => i.state === "open");
  const leftOut = everyone.filter((j) => j.excluded).length;
  // Leniency is a scores-mode idea: the engine's own standing per judge, keyed by id.
  const norm = judgingModeOf(event) === "scores" ? guardPage(() => getNormalization(actor, key)).normalization : null;
  const standing = new Map((norm?.judges ?? []).map((s) => [s.id, s]));
  const k = norm?.variance.k ?? null;
  const drawn = (norm?.judges ?? []).filter((s) => !s.excluded && s.nAll > 0);
  const span = leniencySpan(drawn.flatMap((s) => [s.tilt ?? 0, s.leniency]));

  return (
    <WorkShell
      eventName={event.name}
      eventHref={`/organize/${event.slug}`}
      tabs={organizerTabs(event.slug, "Judges")}
      tools={<LiveRefresh />}
      person={actor.name}
      role="Organizer"
    >
      <div className="flex flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
          <div>
            <h1 className="text-24 font-semibold">Judges</h1>
            <p className="mt-2 text-15 text-ink-2 tnum">
              {plural(everyone.length, "judge")} · {finished} of {plural(assigned, "assigned review")} finished
              {idle.length ? ` · ${idle.length} not started` : ""}
              {leftOut ? ` · ${leftOut} left out of the ranking` : ""}
              {a.underReviewed.length ? ` · ${a.underReviewed.length} under-reviewed ${a.underReviewed.length === 1 ? "project" : "projects"}` : ""}
            </p>
          </div>
          {assigned ? (
            // FIG. 01: every assigned review as one cell, one column per judge in the table's order:
            // the height is the judge's load, the filled cells the reviews they have finished.
            <figure className="flex min-w-0 flex-col gap-2">
              <div className="flex max-w-full items-end gap-[3px] overflow-x-auto" aria-hidden>
                {everyone.map((j) => (
                  <div key={j.id} title={`${j.name}: ${j.done} of ${j.assigned}`} className="flex w-3 shrink-0 flex-col-reverse gap-[2px]">
                    {Array.from({ length: j.assigned }, (_, i) => (
                      <span key={i} className={`h-[5px] ${j.excluded ? (i < j.done ? "bg-flag-bar" : "border border-flag-bar") : i < j.done ? "bg-ink" : "border border-edge"}`} />
                    ))}
                    <span className={`h-[2px] ${j.excluded ? "bg-flag-bar" : "bg-ink-3"}`} />
                  </div>
                ))}
              </div>
              <figcaption className="text-12 text-ink-2">
                <span className="label-mono mr-2 text-ink">Fig. 01 — The load</span>
                one column per judge, one cell per assigned review, filled when finished{everyone.some((j) => j.excluded) ? "; orange: left out of the ranking" : ""}
              </figcaption>
            </figure>
          ) : null}
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="judges-title" className="min-w-0">
            <h2 id="judges-title" className="sr-only">
              Every judge
            </h2>
            {assigned ? (
              // The views are plain links, so each is server-rendered and has its own address to share or come back to.
              <nav aria-label="Filter the judges" className="mb-3 flex flex-wrap items-center gap-1.5">
                <Link href={viewHref(null)} aria-current={onlyIdle ? undefined : "page"} className={chip}>
                  All <span className={chipCount}>{everyone.length}</span>
                </Link>
                {idle.length || onlyIdle ? (
                  <Link href={viewHref(NOT_STARTED)} aria-current={onlyIdle ? "page" : undefined} className={chip}>
                    {groups[1]} <span className={chipCount}>{idle.length}</span>
                  </Link>
                ) : (
                  <span className="inline-flex items-baseline gap-1.5 rounded-sm border border-dashed border-rule px-3 py-1 text-13 text-ink-3">
                    Every judge has started
                  </span>
                )}
              </nav>
            ) : null}
            {onlyIdle ? (
              // The not-started view: who has reviews and has saved nothing, and everything to remind them at once.
              <div className="mb-4 flex flex-col gap-3 rounded-sm border border-rule bg-surface p-4 md:flex-row md:items-center md:justify-between">
                <p className="max-w-[560px] text-14 text-ink-2">
                  {idle.length
                    ? `${idle.length === 1 ? "This judge has" : `These ${idle.length} judges have`} reviews assigned and ${idle.length === 1 ? "has" : "have"} saved nothing yet: no score, no word of feedback, no conflict declared.${published ? " Results are published, so scoring is over." : ""}`
                    : "Every judge with reviews assigned has saved something."}
                </p>
                {idle.length ? (
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {published ? null : (
                      <CopyButton text={idle.map(nudge).join("\n\n")} label={`Copy ${idle.length} ${idle.length === 1 ? "reminder" : "reminders"}`} />
                    )}
                    {mailable ? <EmailReminder eventSlug={event.slug} label={`Email ${idle.length} ${idle.length === 1 ? "reminder" : "reminders"}`} /> : null}
                    <CopyButton text={idle.map((j) => `${j.name} <${j.email}>`).join(", ")} label={idle.length === 1 ? "Copy address" : "Copy addresses"} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {judges.length === 0 && onlyIdle ? null : judges.length === 0 ? (
              <p className="rounded-sm border border-rule bg-surface p-6 text-15 text-ink-2">
                {emailIsOn()
                  ? "No judges yet. Make an invitation on the right: with an email address, the portal mails the judge the link; without one, send the link yourself."
                  : "No judges yet. Make an invitation link on the right and send it to each judge yourself: this portal sends no email."}
              </p>
            ) : (
              <>
              {norm && k !== null && drawn.length ? (
                <p className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-12 text-ink-2">
                  <span className="label-mono text-ink">Fig. 02 — Leniency</span>
                  <span className="flex items-center gap-1.5" aria-hidden>
                    <span className="inline-block size-2 rounded-full border border-ink-2" /> plain tilt against co-reviewers
                  </span>
                  <span className="flex items-center gap-1.5" aria-hidden>
                    <span className="inline-block size-2 rounded-full bg-ink" /> what the engine takes off, k = {k.toFixed(1)}
                  </span>
                  <a href={`/organize/${event.slug}/results#ledger-title`} className="underline underline-offset-2 hover:text-ink">
                    The working, per judge, in Results
                  </a>
                </p>
              ) : null}
              <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
                <Table className="max-md:block">
                  <TableHeader className="max-md:hidden">
                    <TableRow>
                      <TableHead>Judge</TableHead>
                      <TableHead>Tracks</TableHead>
                      <TableHead className="text-right">Reviews</TableHead>
                      {norm ? (
                        <TableHead className="h-auto py-1.5">
                          <span className="block">Leniency</span>
                          {k !== null && drawn.length ? <LeniencyAxis span={span} /> : null}
                        </TableHead>
                      ) : null}
                      <TableHead>Standing</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="max-md:block">
                    {judges.map((j, n) => {
                      const g = groupOf(j);
                      const first = grouped && (n === 0 || groupOf(judges[n - 1]) !== g);
                      const work = openWork(j.pending, published);
                      const reminder = nudge(j);
                      return (
                        <Fragment key={j.id}>
                        {first ? (
                          <TableRow className="h-auto bg-sunken hover:bg-sunken max-md:block">
                            <TableCell colSpan={norm ? 5 : 4} className="py-1.5 max-md:block max-md:px-4">
                              <span className={`label-mono ${g === 0 ? "text-flag" : "text-ink-2"}`}>
                                {groups[g]} · {judges.filter((x) => groupOf(x) === g).length}
                              </span>
                            </TableCell>
                          </TableRow>
                        ) : null}
                        {/* The tracks open in a row of their own below, across the table: inside the narrow Tracks cell
                            they widened the column and slid every column beside it sideways, and the boxes wrapped letter by letter. */}
                        <DetailRows
                          colSpan={norm ? 5 : 4}
                          detailRowClassName="border-b border-rule max-md:block"
                          detailCellClassName="px-2 pt-1 pb-4 max-md:block max-md:px-4"
                          detail={
                            <>
                            <div className="max-w-[560px]">
                              {/* a track a hand assignment added reaches every project in it: say where it came from */}
                              {j.tracks
                                .filter((t) => t.byHand)
                                .map((t) => (
                                  <p key={t.id} className="mt-2 text-13 text-ink-2">
                                    {t.name} came with the hand assignment of {t.byHand!.project}, {formatUtc(t.byHand!.at)}.
                                  </p>
                                ))}
                              <TracksForm eventSlug={event.slug} judgeId={j.id} tracks={tracks} checked={j.tracks.map((t) => t.id)} />
                            </div>
                            {published ? null : (
                              // What an organizer can do to the judge as a whole: remove them.
                              <div className="mt-4 flex max-w-[560px] flex-col items-start gap-3 border-t border-rule pt-4 text-13 text-ink-2">
                                <p>
                                  Remove {j.name} from this event, for an invitation accepted by the wrong account or a judge who has to go.
                                  {j.pending ? ` Their ${plural(j.pending, "open review")} ${j.pending === 1 ? "is" : "are"} withdrawn if not started.` : ""}{" "}
                                  Whatever they saved stays on record, out of the ranking, and the results name them as removed.
                                </p>
                                <WithReason label="Remove judge…" submit="Remove" action={removeJudgeAction} hidden={{ judge: j.id }} eventSlug={event.slug} idKey={`remove-${j.id}`} />
                              </div>
                            )}
                            </>
                          }
                        >
                        {/* On phones each row stacks: name and reviews side by side, then tracks, leniency and standing. */}
                        <TableRow
                          className={`align-top [&:has(+tr[hidden]:last-child)]:border-b-0 max-md:grid max-md:h-auto max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-4 max-md:gap-y-2.5 max-md:px-4 max-md:py-3.5 ${j.excluded ? "max-md:shadow-[inset_3px_0_0_var(--flag-bar)]" : ""}`}
                        >
                          <TableCell className={`max-md:col-start-1 max-md:row-start-1 max-md:block max-md:p-0 ${j.excluded ? "md:shadow-[inset_3px_0_0_var(--flag-bar)]" : ""}`}>
                            {published ? (
                              <>
                                <p className="font-medium">{j.name}</p>
                                <p className="text-13 text-ink-2">{j.email}</p>
                              </>
                            ) : (
                              // The name opens the same row below as the tracks: what an organizer can do to the judge, removal included.
                              <DetailToggle>
                                <span className="font-medium">{j.name}</span>
                                <span className="block text-13 text-ink-2">{j.email}</span>
                                <span className="sr-only">: tracks, or remove this judge</span>
                              </DetailToggle>
                            )}
                          </TableCell>
                          <TableCell className="max-w-[220px] max-md:col-span-2 max-md:block max-md:max-w-none max-md:p-0">
                            <DetailToggle className="text-14">
                              {j.tracks.map((t) => (t.byHand ? `${t.name} (by hand)` : t.name)).join(", ") || "No tracks"}
                              <span className="sr-only">: change the tracks of {j.name}</span>
                            </DetailToggle>
                          </TableCell>
                          <TableCell className="text-right tnum max-md:col-start-2 max-md:row-start-1 max-md:block max-md:p-0">
                            <div className="flex items-center justify-end gap-2.5">
                              {j.assigned ? (
                                <span className="flex gap-[2px]" aria-hidden>
                                  {Array.from({ length: j.assigned }, (_, i) => (
                                    <span
                                      key={i}
                                      className={`h-2.5 w-[7px] ${j.excluded ? (i < j.done ? "bg-flag-bar" : "border border-flag-bar") : i < j.done ? "bg-ink" : "border border-edge"}`}
                                    />
                                  ))}
                                </span>
                              ) : null}
                              <span className="whitespace-nowrap" title={j.lastScoredAt ? `last review ${formatUtc(j.lastScoredAt)}` : undefined}>
                                {j.done} of {j.assigned}
                              </span>
                            </div>
                            {j.recused ? <p className="mt-1 text-12 text-ink-2">{j.recused} recused</p> : null}
                          </TableCell>
                          {norm ? (
                            <TableCell className="max-md:col-span-2 max-md:block max-md:p-0">
                              <Leniency s={standing.get(j.id)} k={k} span={span} />
                            </TableCell>
                          ) : null}
                          <TableCell
                            className={`max-w-[260px] text-13 max-md:col-span-2 max-md:max-w-none max-md:p-0 ${
                              // On phones a finished judge's standing is a lone check under the group's "All finished": drop it.
                              grouped && g === FINISHED && !j.flat && !j.override ? "max-md:hidden" : "max-md:block"
                            }`}
                          >
                            {j.flat ? (
                              <p className={j.excluded ? "text-flag" : "text-ink-2"}>
                                Flat: {j.flat.vector.join(" / ")} on all {j.flat.reviews} projects.{" "}
                                {j.excluded ? "Left out of the ranking." : "Reinstated by an organizer."}
                                {/* The keep-out-or-reinstate decision lives on the overview: point there while it is open. */}
                                {!j.override && !published ? (
                                  <a href={`/organize/${event.slug}#decisions-title`} className="mt-1 block font-medium text-ink underline underline-offset-2">
                                    Decide on the overview
                                  </a>
                                ) : null}
                              </p>
                            ) : j.excluded ? (
                              <p className="text-flag">Excluded by an organizer.</p>
                            ) : j.pending > 0 ? (
                              <div className="flex flex-col items-start gap-1">
                                {/* with the email button beside the copy one the row wraps in the narrow cell; without it, as before */}
                                <div className={mailable && onlyIdle ? "flex flex-wrap items-center gap-x-3 gap-y-2" : "flex items-center gap-3"}>
                                  <p className="font-medium whitespace-nowrap">{work.label}</p>
                                  {/* once results are published scoring is over: there is nothing to remind anyone of */}
                                  {work.remind ? <CopyButton text={reminder} label="Copy reminder" /> : null}
                                  {work.remind && mailable && onlyIdle ? <EmailReminder eventSlug={event.slug} judge={j.id} label="Email reminder" name={j.name} /> : null}
                                </div>
                                {/* When a judge last scored matters only while they still have work: it shows who has gone quiet. */}
                                <p className={`text-12 text-ink-3 ${work.note ? "" : "whitespace-nowrap"}`}>
                                  {work.note ?? (j.lastScoredAt ? `last review ${formatUtc(j.lastScoredAt)}` : j.notStarted ? "nothing saved yet" : "nothing scored yet")}
                                </p>
                              </div>
                            ) : j.assigned > 0 ? (
                              // Under the "All finished" label the words would repeat on every row: the check says it.
                              <p className="flex items-center gap-1.5 text-ink-2">
                                <Check className="size-3.5 shrink-0 text-ok" aria-hidden />
                                <span className={grouped ? "sr-only" : undefined}>All finished</span>
                              </p>
                            ) : (
                              <p className="text-ink-2">Nothing assigned yet</p>
                            )}
                            {j.override ? <p className="mt-1 text-12 text-ink-2">Reason: {j.override.reason}</p> : null}
                          </TableCell>
                        </TableRow>
                        </DetailRows>
                        </Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              </>
            )}
            {removed.length ? (
              <div className="mt-6">
                <h3 className="text-14 font-semibold">
                  Removed judges <span className="font-normal text-ink-2">· what they saved stays on record, out of the ranking</span>
                </h3>
                <ul className="mt-2 flex flex-col divide-y divide-rule rounded-sm border border-rule bg-surface">
                  {removed.map((r) => (
                    <li key={r.id} className="flex flex-col gap-0.5 px-4 py-2.5 text-13">
                      <span className="wrap-anywhere">
                        <span className="text-14 font-medium">{r.name}</span> <span className="text-ink-2">· {r.email}</span>
                      </span>
                      <span className="text-ink-2">
                        Removed {formatUtc(r.at)}: “{r.reason}”
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          <aside className="flex flex-col gap-8">
            <section aria-labelledby="invite-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="invite-title" className="text-17 font-semibold">
                Invite a judge
              </h2>
              <p className="mt-1 mb-4 text-14 text-ink-2">The link makes whoever opens it, signed in, a judge for the tracks you tick.</p>
              <InviteForm eventSlug={event.slug} tracks={tracks} />
              <details className="mt-5 border-t border-rule pt-4">
                <summary className="cursor-pointer text-14 font-semibold">Invite several at once</summary>
                <BatchInviteForm eventSlug={event.slug} tracks={tracks} />
              </details>
              {invites.length ? (
                <div className="mt-5 border-t border-rule pt-4">
                  <h3 id="invites-title" className="text-14 font-semibold">
                    Invitations <span className="font-normal text-ink-2">· {openInvites.length} open</span>
                  </h3>
                  <ul className="mt-2 flex flex-col divide-y divide-rule">
                    {invites.map((i) => (
                      <li key={i.id} className="flex items-start justify-between gap-3 py-2.5 text-13">
                        <span className="min-w-0 wrap-anywhere">
                          <span className={`block text-14 font-medium ${i.state === "revoked" ? "text-ink-3 line-through" : ""}`}>{i.name || i.email || "Open link"}</span>
                          <span className="block text-ink-2">
                            {i.name && i.email ? `${i.email} · ` : ""}
                            {i.tracks.join(", ")}
                          </span>
                          <span className="block text-ink-3">
                            {i.state === "open" ? `made ${formatUtc(i.createdAt)}` : i.state === "used" ? `accepted by ${i.acceptedBy ?? "a judge"}` : i.replaced ? "replaced by a newer invitation" : "revoked"}
                          </span>
                        </span>
                        {i.state === "open" ? (
                          <RevokeInviteForm eventSlug={event.slug} inviteId={i.id} />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
            <section aria-labelledby="assign-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="assign-title" className="text-17 font-semibold">
                Assignment
              </h2>
              <p className="mt-1 mb-4 text-14 text-ink-2">
                {published
                  ? "Results are published, so the assignments are final."
                  : a.hasAssignments
                    ? `A top-up keeps every existing pair and fills only missing reviews${a.wouldAdd ? `: ${a.wouldAdd} to add right now` : "; right now there is nothing to add"}.`
                    : `Gives each of the ${a.projects} submitted projects its reviews from judges of its own track: the most constrained project first, the least-loaded judge, ties by a stored seed.`}
              </p>
              {published ? null : <RunForm eventSlug={event.slug} hasAssignments={a.hasAssignments} target={a.target} />}
              {a.runs.length ? (
                <ol className="mt-5 flex flex-col gap-2 border-t border-rule pt-4">
                  {a.runs.map((r) => (
                    <li key={r.id} className="text-13">
                      <span className="font-medium">
                        {r.params.byHand ? "By hand" : r.mode === "fixture" ? "Imported" : r.mode === "fresh" ? "Fresh run" : "Top-up"}
                      </span>
                      <span className="text-ink-2">
                        {" "}
                        · {r.pairs} {r.pairs === 1 ? "pair" : "pairs"}
                        {r.mode === "fixture" || r.params.byHand ? "" : ` · seed ${r.seed}`} · {formatUtc(r.createdAt)}
                        {r.createdBy ? ` · ${r.createdBy}` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
          </aside>
        </div>

        {a.underReviewed.length ? (
          <section aria-labelledby="under-title">
            <h2 id="under-title" className="text-17 font-semibold">
              Under-reviewed projects
            </h2>
            <p className="mt-1 text-14 text-ink-2">
              Fewer than two judges can review these in their own track. The engine never crosses tracks by itself: give each one a judge by hand, with a reason. A judge from another track gets this track added to theirs, so no judge sees a project outside their own tracks.
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {a.underReviewed.map((u) => (
                <li key={u.projectId} className="rounded-sm border border-rule border-l-[3px] border-l-flag-bar bg-surface p-4">
                  <details>
                    <summary className="cursor-pointer wrap-anywhere">
                      <span className="font-medium">{u.title}</span>
                      <span className="text-14 text-ink-2">
                        {" "}
                        · {u.track} · {u.eligible} eligible {u.eligible === 1 ? "judge" : "judges"} in the track
                      </span>
                    </summary>
                    {published ? (
                      <p className="mt-2 text-13 text-ink-2">Results are published, so no judge is added now.</p>
                    ) : (
                      <ByHandForm
                        eventSlug={event.slug}
                        projectId={u.projectId}
                        judges={judges
                          .filter((j) => !j.excluded)
                          .map((j) => ({ id: j.id, name: j.name, inTrack: j.tracks.some((t) => t.id === u.trackId) }))
                          .sort((x, y) => Number(y.inTrack) - Number(x.inTrack) || x.name.localeCompare(y.name))}
                      />
                    )}
                  </details>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

      </div>
    </WorkShell>
  );
}
