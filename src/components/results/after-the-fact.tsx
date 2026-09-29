import Link from "next/link";
import { formatUtc, plural } from "@/lib/format";
import { tieBrokenWords, tieDecided } from "@/lib/places";
import { trackMoveWords } from "@/lib/track-move";
import { weightMoves } from "@/lib/weight-change";

// What the organizers changed after the fact, as every public page that shows the published places
// discloses it: the per-track results and the overall order draw these same blocks and row marks.

type Weights = { id: string; label: string; weight: number }[];
type WeightChange = { at: string; reason: string; before: Weights; after: Weights };
type Move = { fromTrack: string; toTrack: string; at: string; reason: string };
type TieBreakChange = { at: string; reason: string; before: { label: string } | null; after: { label: string } | null };

/** The rubric's weights changed after judging began: each change with its date and the organizers' reason. */
export function WeightChangesNotice({ changes, className = "" }: { changes: WeightChange[]; className?: string }) {
  if (!changes.length) return null;
  return (
    <div className={`max-w-[760px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag ${className}`}>
      <p className="font-semibold">The organizers changed the rubric&rsquo;s weights after judging began.</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {changes.map((c, i) => (
          <li key={i}>
            <span className="tnum">{formatUtc(c.at)}</span>: {weightMoves(c)}. Their reason: &ldquo;{c.reason}&rdquo;
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How exact ties are broken was chosen or changed after judging began: each change with its date and the organizers' reason. */
export function TieBreakChangesNotice({ changes, className = "" }: { changes: TieBreakChange[] | undefined; className?: string }) {
  if (!changes?.length) return null;
  return (
    <div className={`max-w-[760px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag ${className}`}>
      <p className="font-semibold">The organizers chose how exact ties are broken after judging began.</p>
      <ul className="mt-1.5 flex flex-col gap-1">
        {changes.map((c, i) => (
          <li key={i}>
            <span className="tnum">{formatUtc(c.at)}</span>: {c.before ? `by ${c.before.label}` : "joint places"} → {c.after ? `by ${c.after.label}` : "joint places"}. Their
            reason: &ldquo;{c.reason}&rdquo;
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How many of the listed projects were moved to another track after judges were assigned; each is marked on its row. */
export function TrackMovesNotice({ count, className = "" }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <div className={`max-w-[760px] border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag ${className}`}>
      <p className="font-semibold">The organizers moved {plural(count, "project")} to another track after judges were assigned.</p>
      <p className="mt-1.5">Places compare within a track, so each move is marked on its project below, with the date and their reason.</p>
    </div>
  );
}

/** Group the published run's moves by project, for the row marks. */
export function movesByProject<M extends Move & { projectId: string }>(moves: M[]): Map<string, M[]> {
  const out = new Map<string, M[]>();
  for (const m of moves) out.set(m.projectId, [...(out.get(m.projectId) ?? []), m]);
  return out;
}

/**
 * A row's own marks: its team changed after the close, its place decided by the event's tie-break (the criterion and
 * the row's figure on it), and each move of it to another track with the reason.
 */
export function RowChangeMarks({
  projectHref,
  teamChangedAt,
  tieBrokenBy,
  moves,
}: {
  projectHref: string;
  teamChangedAt: string | null;
  /** only when the event's tie-break decided this row's place: the criterion's name and the row's figure on it */
  tieBrokenBy: { criterion: string; figure: number | null } | null;
  moves: Move[] | undefined;
}) {
  return (
    <>
      {teamChangedAt ? (
        <span className="mt-1 block text-13 text-ink-2 wrap-anywhere">
          Team changed by the organizers after submissions closed, <span className="tnum">{formatUtc(teamChangedAt)}</span>:{" "}
          <Link href={projectHref} className="underline underline-offset-4 hover:text-accent-ink">
            see the project page
          </Link>
        </span>
      ) : null}
      {tieBrokenBy ? (
        <span className="mt-1 block text-13 text-ink-2 wrap-anywhere">
          {tieBrokenWords(tieBrokenBy.criterion)}
          {/* the criterion's own figure, named as what it is: a plain average, not a scored number with a ± */}
          {tieBrokenBy.figure !== null ? (
            <>
              , plain average on {tieBrokenBy.criterion} <span className="tnum">{tieBrokenBy.figure.toFixed(2)}</span>
            </>
          ) : null}
        </span>
      ) : null}
      {moves?.map((m, mi) => (
        <span key={mi} className="mt-1 block text-13 text-flag wrap-anywhere">
          <span className="tnum">{trackMoveWords(m)}</span>. Their reason: &ldquo;{m.reason}&rdquo;
        </span>
      ))}
    </>
  );
}

/**
 * The tie-break mark's words for a row, only when the event's tie-break decided its place in its track (tieDecided: the
 * criterion split the row's exact score tie and left it alone at that place); null otherwise, also for a place the
 * criterion left joint.
 */
export function tieBrokenByOf(
  row: { tieBroken?: boolean; tie?: number | null },
  tieBreak: { criterion: string } | undefined,
  place: { place: number | null; joint: boolean },
): { criterion: string; figure: number | null } | null {
  return tieBreak && tieDecided(row, place) ? { criterion: tieBreak.criterion, figure: typeof row.tie === "number" ? row.tie : null } : null;
}

/** A judges' decision as the published results carry it (dal/results.ts PublishedDecision). */
type Decision = {
  winnerId: string;
  reason: string;
  scoreOrder: string[];
  close: { id: string; title: string; score: number | null; se: number | null }[];
};

/** The anchor of a track's judges' decision on the per-track results page, so the overall order can link to it. */
export const decisionAnchor = (trackId: string) => `decision-${trackId}`;

const scoreWithSe = (c: Decision["close"][number]) =>
  `${c.title}${c.score !== null ? ` ${c.score.toFixed(2)}` : ""}${c.score !== null && c.se !== null ? ` ± ${c.se.toFixed(2)}` : ""}`;

/**
 * A close call the judges decided: who they named, their reason, the close projects with their scores, and the order
 * the scores alone give. No chance of being first: the portal shows no prize odds (JUDGING.md, "What it does not do").
 */
export function JudgesDecision({ trackId, decision, titles }: { trackId: string; decision: Decision; titles: Map<string, string> }) {
  return (
    <div id={decisionAnchor(trackId)} className="mt-3 scroll-mt-24 border-l-[3px] border-accent bg-accent-tint px-4 py-3 text-14 leading-6 wrap-anywhere">
      <p>
        <strong>Winner by the judges&rsquo; decision: {titles.get(decision.winnerId) ?? decision.winnerId}.</strong> Their reason: &ldquo;{decision.reason}&rdquo;
      </p>
      <p className="mt-1 text-13 text-ink-2 tnum">
        Too close to call from the scores: {decision.close.map(scoreWithSe).join(", ")}. By score alone the order is{" "}
        {decision.scoreOrder.map((id) => titles.get(id) ?? id).join(", ")}; the scores below are unchanged.
      </p>
    </div>
  );
}

/**
 * The overall order's mark on a track's winner by the judges' decision: the place is theirs, not the score's (it can sit
 * below a 2nd with a higher score), with their reason and a link to the close call on the per-track page.
 */
export function DecidedMark({ reason, href }: { reason: string; href: string }) {
  return (
    <span className="mt-1 block text-13 text-ink-2 wrap-anywhere">
      1st in its track by the judges&rsquo; decision on a close call. Their reason: &ldquo;{reason}&rdquo;{" "}
      <Link href={href} className="underline underline-offset-4 hover:text-accent-ink">
        see the close call
      </Link>
    </span>
  );
}
