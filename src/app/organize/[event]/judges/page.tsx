import { Check } from "lucide-react";
import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { LeniencyAxis, LeniencyRow, leniencySpan } from "@/components/figures/leniency-row";
import { currentActor, getAssignments, getJudges, getNormalization, judgingModeOf, type JudgeStanding } from "@/server/dal";
import { revokeInviteAction } from "./actions";
import { ByHandForm, CopyButton, InviteForm, RunForm, TracksForm } from "./forms";

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

export default async function JudgesPage({ params }: PageProps<"/organize/[event]/judges">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, tracks, judges, invites } = guardPage(() => getJudges(actor, key));
  const a = getAssignments(actor, event.id);
  const published = Boolean(event.resultsPublishedAt);
  const origin = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const assigned = judges.reduce((s, j) => s + j.assigned, 0);
  const finished = judges.reduce((s, j) => s + j.done, 0);
  const openInvites = invites.filter((i) => i.state === "open");
  const leftOut = judges.filter((j) => j.excluded).length;
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
              {plural(judges.length, "judge")} · {finished} of {plural(assigned, "assigned review")} finished
              {leftOut ? ` · ${leftOut} left out of the ranking` : ""}
              {a.underReviewed.length ? ` · ${a.underReviewed.length} under-reviewed ${a.underReviewed.length === 1 ? "project" : "projects"}` : ""}
            </p>
          </div>
          {assigned ? (
            // FIG. 01: every assigned review as one cell, one column per judge in the table's order:
            // the height is the judge's load, the filled cells the reviews they have finished.
            <figure className="flex min-w-0 flex-col gap-2">
              <div className="flex max-w-full items-end gap-[3px] overflow-x-auto" aria-hidden>
                {judges.map((j) => (
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
                one column per judge, one cell per assigned review, filled when finished{judges.some((j) => j.excluded) ? "; orange: left out of the ranking" : ""}
              </figcaption>
            </figure>
          ) : null}
        </header>

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="judges-title" className="min-w-0">
            <h2 id="judges-title" className="sr-only">
              Every judge
            </h2>
            {judges.length === 0 ? (
              <p className="rounded-sm border border-rule bg-surface p-6 text-15 text-ink-2">
                No judges yet. Make an invitation link on the right and send it to each judge yourself: this portal sends no email.
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
                    {judges.map((j) => {
                      const reminder = `Hi ${j.name}, ${j.pending} of your ${plural(j.assigned, "review")} for ${event.name} ${j.pending === 1 ? "is" : "are"} still open. Your console: ${origin}/judge/${event.slug}`;
                      return (
                        // On phones each row stacks: name and reviews side by side, then tracks, leniency and standing.
                        <TableRow
                          key={j.id}
                          className={`align-top max-md:grid max-md:h-auto max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-4 max-md:gap-y-2.5 max-md:px-4 max-md:py-3.5 ${j.excluded ? "max-md:shadow-[inset_3px_0_0_var(--flag-bar)]" : ""}`}
                        >
                          <TableCell className={`max-md:col-start-1 max-md:row-start-1 max-md:block max-md:p-0 ${j.excluded ? "md:shadow-[inset_3px_0_0_var(--flag-bar)]" : ""}`}>
                            <p className="font-medium">{j.name}</p>
                            <p className="text-13 text-ink-2">{j.email}</p>
                          </TableCell>
                          <TableCell className="max-w-[220px] max-md:col-span-2 max-md:block max-md:max-w-none max-md:p-0">
                            <details>
                              <summary className="cursor-pointer text-14">{j.tracks.map((t) => t.name).join(", ") || "No tracks"}</summary>
                              <TracksForm eventSlug={event.slug} judgeId={j.id} tracks={tracks} checked={j.tracks.map((t) => t.id)} />
                            </details>
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
                              <span className="whitespace-nowrap">
                                {j.done} of {j.assigned}
                              </span>
                            </div>
                            {j.recused ? <p className="mt-1 text-12 text-ink-2">{j.recused} recused</p> : null}
                            {j.lastScoredAt ? <p className="mt-1 text-12 whitespace-nowrap text-ink-3">last {formatUtc(j.lastScoredAt)}</p> : null}
                          </TableCell>
                          {norm ? (
                            <TableCell className="max-md:col-span-2 max-md:block max-md:p-0">
                              <Leniency s={standing.get(j.id)} k={k} span={span} />
                            </TableCell>
                          ) : null}
                          <TableCell className="max-w-[260px] text-13 max-md:col-span-2 max-md:block max-md:max-w-none max-md:p-0">
                            {j.flat ? (
                              <p className={j.excluded ? "text-flag" : "text-ink-2"}>
                                Flat: {j.flat.vector.join(" / ")} on all {j.flat.reviews} projects.{" "}
                                {j.excluded ? "Left out of the ranking." : "Reinstated by an organizer."}
                              </p>
                            ) : j.excluded ? (
                              <p className="text-flag">Excluded by an organizer.</p>
                            ) : j.pending > 0 ? (
                              <div className="flex flex-col items-start gap-2">
                                <p className="text-ink-2">{j.pending} open</p>
                                <CopyButton text={reminder} label="Copy reminder" />
                              </div>
                            ) : j.assigned > 0 ? (
                              <p className="flex items-center gap-1.5 text-ink-2">
                                <Check className="size-3.5 shrink-0 text-ok" aria-hidden />
                                All finished
                              </p>
                            ) : (
                              <p className="text-ink-2">Nothing assigned yet</p>
                            )}
                            {j.override ? <p className="mt-1 text-12 text-ink-2">Reason: {j.override.reason}</p> : null}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              </>
            )}
          </section>

          <aside className="flex flex-col gap-8">
            <section aria-labelledby="invite-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="invite-title" className="text-17 font-semibold">
                Invite a judge
              </h2>
              <p className="mt-1 mb-4 text-14 text-ink-2">The link makes whoever opens it, signed in, a judge for the tracks you tick.</p>
              <InviteForm eventSlug={event.slug} tracks={tracks} />
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
                            {i.state === "open" ? `made ${formatUtc(i.createdAt)}` : i.state === "used" ? `accepted by ${i.acceptedBy ?? "a judge"}` : "revoked"}
                          </span>
                        </span>
                        {i.state === "open" ? (
                          <form action={revokeInviteAction} className="shrink-0">
                            <input type="hidden" name="event" value={event.slug} />
                            <input type="hidden" name="invite" value={i.id} />
                            <Button size="sm" variant="ghost">
                              Revoke
                            </Button>
                          </form>
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
