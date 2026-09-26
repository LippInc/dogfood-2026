import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { LiveRefresh } from "@/components/live-refresh";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUtc } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { currentActor, getAssignments, getJudges } from "@/server/dal";
import { revokeInviteAction } from "./actions";
import { ByHandForm, CopyButton, InviteForm, RunForm, TracksForm } from "./forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Judges" };

export default async function JudgesPage({ params }: PageProps<"/organize/[event]/judges">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const { event, tracks, judges, invites } = guardPage(() => getJudges(actor, key));
  const a = getAssignments(actor, event.id);
  const origin = process.env.PUBLIC_URL ?? "http://localhost:8080";
  const assigned = judges.reduce((s, j) => s + j.assigned, 0);
  const finished = judges.reduce((s, j) => s + j.done, 0);
  const openInvites = invites.filter((i) => i.state === "open");

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
        <header>
          <h1 className="text-24 font-semibold">Judges</h1>
          <p className="mt-2 text-15 text-ink-2 tnum">
            {judges.length} judges · {finished} of {assigned} assigned reviews finished
            {a.underReviewed.length ? ` · ${a.underReviewed.length} under-reviewed ${a.underReviewed.length === 1 ? "project" : "projects"}` : ""}
          </p>
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
              <div className="overflow-x-auto rounded-sm border border-rule bg-surface">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Judge</TableHead>
                      <TableHead>Tracks</TableHead>
                      <TableHead className="text-right">Finished</TableHead>
                      <TableHead>Last review</TableHead>
                      <TableHead>Standing</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {judges.map((j) => {
                      const reminder = `Hi ${j.name}, ${j.pending} of your ${j.assigned} reviews for ${event.name} are still open. Your console: ${origin}/judge/${event.slug}`;
                      return (
                        <TableRow key={j.id} className="align-top">
                          <TableCell>
                            <p className="font-medium">{j.name}</p>
                            <p className="text-13 text-ink-2">{j.email}</p>
                          </TableCell>
                          <TableCell className="max-w-[220px]">
                            <details>
                              <summary className="cursor-pointer text-14">{j.tracks.map((t) => t.name).join(", ") || "No tracks"}</summary>
                              <TracksForm eventSlug={event.slug} judgeId={j.id} tracks={tracks} checked={j.tracks.map((t) => t.id)} />
                            </details>
                          </TableCell>
                          <TableCell className="text-right tnum">
                            <p>
                              {j.done} / {j.assigned}
                            </p>
                            <div className="mt-1 ml-auto h-1 w-20 rounded-full bg-sunken" aria-hidden>
                              <div className="h-1 rounded-full bg-ink" style={{ width: `${j.assigned ? (j.done / j.assigned) * 100 : 0}%` }} />
                            </div>
                            {j.recused ? <p className="mt-1 text-12 text-ink-2">{j.recused} recused</p> : null}
                          </TableCell>
                          <TableCell className="text-13 text-ink-2">{j.lastScoredAt ? formatUtc(j.lastScoredAt) : "–"}</TableCell>
                          <TableCell className="max-w-[260px] text-13">
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
                              <p className="text-ok">All finished</p>
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
            )}
          </section>

          <aside className="flex flex-col gap-8">
            <section aria-labelledby="invite-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="invite-title" className="text-17 font-semibold">
                Invite a judge
              </h2>
              <p className="mt-1 mb-4 text-14 text-ink-2">The link makes whoever opens it, signed in, a judge for the tracks you tick.</p>
              <InviteForm eventSlug={event.slug} tracks={tracks} />
            </section>
            <section aria-labelledby="assign-title" className="rounded-sm border border-rule bg-surface p-5">
              <h2 id="assign-title" className="text-17 font-semibold">
                Assignment
              </h2>
              <p className="mt-1 mb-4 text-14 text-ink-2">
                {a.hasAssignments
                  ? `A top-up keeps every existing pair and fills only missing reviews${a.wouldAdd ? `: ${a.wouldAdd} to add right now` : "; right now there is nothing to add"}.`
                  : `Gives each of the ${a.projects} submitted projects its reviews from judges of its own track: the most constrained project first, the least-loaded judge, ties by a stored seed.`}
              </p>
              <RunForm eventSlug={event.slug} hasAssignments={a.hasAssignments} target={a.target} />
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
              Fewer than two judges can review these in their own track. The engine never crosses tracks by itself: give each one a judge by hand, with a reason.
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {a.underReviewed.map((u) => (
                <li key={u.projectId} className="rounded-sm border border-rule border-l-[3px] border-l-flag-bar bg-surface p-4">
                  <details>
                    <summary className="cursor-pointer">
                      <span className="font-medium">{u.title}</span>
                      <span className="text-14 text-ink-2">
                        {" "}
                        · {u.track} · {u.eligible} eligible {u.eligible === 1 ? "judge" : "judges"} in the track
                      </span>
                    </summary>
                    <ByHandForm
                      eventSlug={event.slug}
                      projectId={u.projectId}
                      judges={judges
                        .filter((j) => !j.excluded)
                        .map((j) => ({ id: j.id, name: j.name, inTrack: j.tracks.some((t) => t.id === u.trackId) }))
                        .sort((x, y) => Number(y.inTrack) - Number(x.inTrack) || x.name.localeCompare(y.name))}
                    />
                  </details>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {invites.length ? (
          <section aria-labelledby="invites-title">
            <h2 id="invites-title" className="text-17 font-semibold">
              Invitations <span className="text-14 font-normal text-ink-2">· {openInvites.length} open</span>
            </h2>
            <ul className="mt-3 divide-y divide-rule rounded-sm border border-rule bg-surface">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-14">
                  <span>
                    <span className="font-medium">{i.name || i.email || "Open link"}</span>
                    <span className="text-ink-2">
                      {" "}
                      · {i.tracks.join(", ")} · made {formatUtc(i.createdAt)}
                    </span>
                  </span>
                  {i.state === "open" ? (
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="event" value={event.slug} />
                      <input type="hidden" name="invite" value={i.id} />
                      <Button size="sm" variant="ghost">
                        Revoke
                      </Button>
                    </form>
                  ) : (
                    <span className="text-13 text-ink-2">{i.state === "used" ? `Accepted by ${i.acceptedBy ?? "a judge"}` : "Revoked"}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </WorkShell>
  );
}
