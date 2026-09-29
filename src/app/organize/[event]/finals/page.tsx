import type { Metadata } from "next";
import { unauthorized } from "next/navigation";
import { organizerTabs, WorkShell } from "@/components/shell/work-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUtc, plural } from "@/lib/format";
import { guardPage } from "@/lib/page-guard";
import { competitionPlaceOf, ordinal } from "@/lib/places";
import { currentActor, getFinals, type FinalsView } from "@/server/dal";
import { AddFinalistForm, CloseFinalsForm, OpenFinalsForm, PanelForm, RemoveFinalistForm } from "./forms";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Finals" };

const two = (x: number | null) => (x === null ? "–" : x.toFixed(2));

export default async function FinalsPage({ params }: PageProps<"/organize/[event]/finals">) {
  const { event: key } = await params;
  const actor = await currentActor();
  if (!actor) unauthorized();
  const f = guardPage(() => getFinals(actor, key));
  const covered = new Set(f.rounds.map((r) => r.track?.id ?? "*"));
  const openable = f.published || covered.has("*") ? [] : f.tracks.filter((t) => !covered.has(t.id));
  return (
    <WorkShell eventName={f.event.name} eventHref={`/organize/${f.event.slug}`} tabs={organizerTabs(f.event.slug, "Finals")} person={actor.name} role="Organizer">
      <div className="flex flex-col gap-8">
        <header className="max-w-[72ch]">
          <h1 className="text-24 font-semibold">Finals</h1>
          <p className="mt-2 text-15 text-ink-2">
            A second round before publishing. The top of a track goes to a panel of judges, and every panelist scores every finalist on the event&apos;s
            rubric. The published places then put the finalists first, in the finals order, and everyone else after them in first-round order. A
            finalist&apos;s finals score is the plain mean of the panelists&apos; weighted totals: everyone scores everyone, so no judge&apos;s leniency
            needs correcting.
          </p>
        </header>

        {f.published ? (
          <p className="border-l-[3px] border-rule pl-3 text-14 text-ink-2">
            Results are published{f.event.resultsPublishedAt ? ` (${formatUtc(f.event.resultsPublishedAt)})` : ""}, so the finals are final.
            {f.rounds.length === 0 ? " This event held none." : ""}
          </p>
        ) : openable.length ? (
          <section aria-labelledby="open-title" className="max-w-[720px] rounded-sm border border-rule bg-surface p-5">
            <h2 id="open-title" className="mb-4 text-17 font-semibold">
              Open finals
            </h2>
            <OpenFinalsForm eventSlug={f.event.slug} tracks={openable} everyTrack={f.rounds.length === 0} />
          </section>
        ) : null}

        {f.rounds.map((r) => (
          <Round key={r.id} round={r} eventSlug={f.event.slug} judges={f.judges} final={f.published || Boolean(r.closedAt)} />
        ))}
      </div>
    </WorkShell>
  );
}

function Round({ round: r, eventSlug, judges, final }: { round: FinalsView; eventSlug: string; judges: { id: string; name: string }[]; final: boolean }) {
  const title = r.track ? r.track.name : "Every track";
  const scored = r.finalists.filter((x) => x.score !== null);
  // places by finals score within each track, as the published places are (a round over every track holds several)
  const places = new Map<string, number>();
  for (const track of new Set(scored.map((x) => x.trackName))) {
    for (const [id, place] of competitionPlaceOf(new Map(scored.filter((x) => x.trackName === track).map((x) => [x.projectId, x.score!])))) places.set(id, place);
  }
  const headingId = `round-${r.id}`;
  // the panelists whose scores count: not removed from the judges, not left out
  const counted = r.panel.filter((p) => p.out === null).length;
  const notes = r.panel.filter((p) => p.out !== null || p.conflicts.length > 0);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-5 border-t border-rule pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 id={headingId} className="text-20 font-semibold">
          Finals · {title}
        </h2>
        <p className="text-13 text-ink-2 tnum">
          {r.closedAt ? `Closed ${formatUtc(r.closedAt)}` : `Open since ${formatUtc(r.openedAt)}`} · {plural(r.finalists.length, "finalist")} · top {r.suggested} suggested ·{" "}
          {plural(r.panel.length, "panelist")}
        </p>
      </div>
      {r.closeReason ? (
        <p className="border-l-[3px] border-flag-bar pl-3 text-14">
          {r.missing ? `Closed with ${plural(r.missing, "score")} missing` : `Closed with ${plural(counted, "counted panelist")}`}: {r.closeReason}
        </p>
      ) : null}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Finals</TableHead>
              <TableHead>Project</TableHead>
              <TableHead className="w-28 text-right">First round</TableHead>
              <TableHead className="w-44 text-right">Finals score</TableHead>
              <TableHead>Why a finalist</TableHead>
              {final ? null : <TableHead className="w-[1%]"><span className="sr-only">Actions</span></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {r.finalists.map((x) => (
              <TableRow key={x.projectId}>
                <TableCell className="font-display text-17 tnum">{places.get(x.projectId) ?? "–"}</TableCell>
                <TableCell>
                  <span className="font-medium">{x.title}</span>
                  {r.track ? null : <span className="block text-12 text-ink-2">{x.trackName}</span>}
                </TableCell>
                <TableCell className="text-right tnum">{x.place === null ? "–" : ordinal(x.place)}</TableCell>
                <TableCell className="text-right tnum">
                  {two(x.score)}
                  {x.se !== null ? <span className="text-12 text-ink-2"> ± {x.se.toFixed(2)}</span> : null}{" "}
                  <span className="text-12 text-ink-2">({x.n}/{counted})</span>
                </TableCell>
                <TableCell className="max-w-[40ch] text-13 text-ink-2">{x.reason ?? (x.inTopN ? `Top ${r.suggested} of the first round` : "Suggested")}</TableCell>
                {final ? null : (
                  <TableCell>
                    <RemoveFinalistForm eventSlug={eventSlug} finalsId={r.id} projectId={x.projectId} title={x.title} inTopN={x.inTopN} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {notes.length || r.panelChanges.length ? (
        <ul className="flex flex-col gap-2 text-14" aria-label="Who does not count, and why">
          {notes.map((p) => (
            <li key={p.id} className="border-l-[3px] border-flag-bar pl-3">
              <span className="font-medium">{p.name}</span>
              {p.out === "removed"
                ? ": removed from the judges. Their finals scores stay on record and do not count."
                : p.out === "left_out"
                  ? ": left out of the ranking. Their finals scores stay on record and do not count."
                  : null}
              {p.conflicts.length ? (
                <>
                  {p.out ? " " : ": "}
                  Conflict of interest with {p.conflicts.map((c) => `${c.title} (${c.why === "own_team" ? "their own team" : "declared in the first round"})`).join(", ")}: not
                  theirs to score, and closing does not wait for it.
                </>
              ) : null}
            </li>
          ))}
          {r.panelChanges.map((c) => (
            <li key={c.at} className="border-l-[3px] border-flag-bar pl-3">
              Panel changed after scoring on {formatUtc(c.at)}: {c.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {final ? (
        <p className="text-14 text-ink-2">
          Panel: {r.panel.map((p) => `${p.name} (${p.scored} of ${p.toScore} scored)`).join(", ") || "nobody"}.
        </p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-3">
          <div className="rounded-sm border border-rule bg-surface p-5">
            <PanelForm eventSlug={eventSlug} finalsId={r.id} judges={judges} panel={r.panel} />
          </div>
          <div className="rounded-sm border border-rule bg-surface p-5">
            <AddFinalistForm eventSlug={eventSlug} finalsId={r.id} candidates={r.candidates} />
          </div>
          <div className="rounded-sm border border-rule bg-surface p-5">
            <h3 className="mb-2 text-14 font-medium">Close the finals</h3>
            <p className="mb-3 text-13 text-ink-2">
              {r.panel.length < 2
                ? "Name a panel first."
                : r.missing === 0
                  ? "Every panelist has scored every finalist."
                  : `${plural(r.missing, "score")} still to come from the panel.`}{" "}
              Publishing waits until the finals are closed.
            </p>
            <CloseFinalsForm eventSlug={eventSlug} finalsId={r.id} missing={r.missing} />
          </div>
        </div>
      )}
    </section>
  );
}
