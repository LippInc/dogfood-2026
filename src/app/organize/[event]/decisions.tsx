"use client";

import { Check, ChevronDown, ChevronRight, Clock, Lock, LockOpen } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { useRescueFocus } from "@/components/use-rescue-focus";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatUtc, votersIn } from "@/lib/format";
import type { ActionResult, Decision, TrackCloseCall } from "@/server/dal";
import {
  acceptAction,
  judgesDecisionAction,
  keepRankingAction,
  undoCloseCallAction,
  mergeAction,
  notDuplicateAction,
  overrideAction,
  publishAction,
  topUpAction,
  undoAcceptAction,
  undoNotDuplicateAction,
  undoOverrideAction,
  unmergeAction,
} from "./decision-actions";

const STAGE: Record<Decision["kind"], string> = {
  duplicate: "04 Eligibility",
  under_reviewed: "06 Scoring",
  flat_judge: "07 Normalization",
  coin_flip_judge: "07 Ranking",
  close_call: "07 Ranking",
};
const idle: ActionResult = { ok: false, message: null };

const rank = (r: number | null) =>
  r === null ? "–" : Number.isInteger(r) ? String(r) : r.toFixed(1);

function hoursApart(a: string | null, b: string | null): string | null {
  if (!a || !b) return null;
  const h = Math.abs(Date.parse(a) - Date.parse(b)) / 3_600_000;
  return h < 1 ? `${Math.round(h * 60)} min apart` : `${Math.round(h)} h apart`;
}

function Result({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  return (
    <p
      role="status"
      className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}
    >
      {state.message}
      {state.fieldErrors?.reason ? ` ${state.fieldErrors.reason[0]}` : ""}
    </p>
  );
}

/** A secondary action that needs a reason: the button reveals the box. */
export function WithReason({
  label,
  submit,
  action,
  hidden,
  eventSlug,
  idKey,
}: {
  label: string;
  submit: string;
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  hidden: Record<string, string | string[]>;
  eventSlug: string;
  /** makes the reason box's id unique when the same label appears more than once */
  idKey?: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, form, pending] = useFormAction(action, idle);
  // Cancel removes the box and its buttons: focus goes back to the button that opened it.
  const opener = useRef<HTMLButtonElement>(null);
  useRescueFocus(() => opener.current, open);
  if (!open) {
    return (
      <Button ref={opener} type="button" variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  return (
    <form {...form} className="flex w-full flex-col gap-2">
      <input type="hidden" name="event" value={eventSlug} />
      {Object.entries(hidden).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((x) => (
          <input key={`${k}-${x}`} type="hidden" name={k} value={x} />
        )),
      )}
      <label className="text-13 font-medium" htmlFor={`reason-${idKey ?? label}`}>
        Reason, for the audit log
      </label>
      <Textarea
        id={`reason-${idKey ?? label}`}
        name="reason"
        rows={2}
        autoFocus
        aria-invalid={Boolean(state.fieldErrors?.reason)}
      />
      <div className="flex items-center gap-3">
        <Button disabled={pending}>{submit}</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function OneClick({
  label,
  action,
  fields,
  eventSlug,
  variant = "primary",
}: {
  label: string;
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  fields: Record<string, string | string[]>;
  eventSlug: string;
  variant?: "primary" | "outline";
}) {
  const [state, form, pending] = useFormAction(action, idle);
  return (
    <form {...form} className="flex flex-col gap-2">
      <input type="hidden" name="event" value={eventSlug} />
      {Object.entries(fields).flatMap(([k, v]) =>
        (Array.isArray(v) ? v : [v]).map((x) => <input key={`${k}-${x}`} type="hidden" name={k} value={x} />),
      )}
      <Button variant={variant} disabled={pending}>
        {pending ? "Recording…" : label}
      </Button>
      <Result state={state} />
    </form>
  );
}

function sentence(d: Decision): string {
  if (d.kind === "close_call") return `${d.trackName}: the top is too close to call from the scores`;
  if (d.kind === "flat_judge")
    return `${d.name} scored every project ${d.vector.join(" / ")}`;
  if (d.kind === "duplicate")
    return `${d.title} was entered ${d.copies.length === 2 ? "twice" : `${d.copies.length} times`} by ${d.team}`;
  if (d.kind === "coin_flip_judge")
    return d.why === "ties" ? `${d.name} called most pairs too close to call` : `${d.name}'s answers agree with the others no more than coin flips`;
  if (d.mode === "pairwise") return `${d.title} was compared by ${d.n} ${d.n === 1 ? "judge" : "judges"}`;
  return `${d.title} has ${d.n} counted ${d.n === 1 ? "review" : "reviews"}`;
}

function stateLine(d: Decision): string {
  if (d.kind === "close_call") {
    if (d.resolved === "kept") return "Ranking's winner kept";
    if (d.resolved === "judges") return `Judges' decision: ${titleOf(d, d.choice?.winnerId)}`;
    return d.stale ? "Your choice no longer fits the scores" : "Too close to call from the scores";
  }
  if (d.kind === "flat_judge") {
    if (!d.resolved) return "Left out by the flat-judge rule";
    return d.resolved.mode === "include"
      ? "Reinstated by you"
      : "Left out, confirmed";
  }
  if (d.kind === "duplicate") {
    if (d.resolved === "merged") return `Merged into ${d.keptId}`;
    if (d.resolved === "not_duplicates") return "Ruled different projects";
    const [a, b] = d.copies;
    const same = a?.repoUrl && a.repoUrl === b?.repoUrl;
    const apart = hoursApart(a?.submittedAt ?? null, b?.submittedAt ?? null);
    return [same ? "Same repository" : "Same team and title", apart]
      .filter(Boolean)
      .join(", ");
  }
  if (d.kind === "coin_flip_judge") {
    if (!d.resolved) return "Their answers still count";
    return d.resolved.mode === "include" ? "Kept by you" : "Left out by you";
  }
  if (d.resolved) return "Publishing as it is";
  return d.waiting
    ? `${d.waiting} more assigned, not finished`
    : "Minimum is 2";
}

/** One decision's working; once the results are published it is final, so no Undo. */
function Body({
  d,
  eventSlug,
  published,
  faces,
}: {
  d: Decision;
  eventSlug: string;
  published: boolean;
  faces: Record<string, React.ReactNode>;
}) {
  if (d.kind === "close_call") return <CloseCallBody c={d} eventSlug={eventSlug} published={published} />;
  if (d.kind === "flat_judge") {
    const first = d.name.split(" ")[0];
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="self-start overflow-x-auto">
          <table className="rounded-sm bg-sunken text-13 whitespace-nowrap">
            <tbody>
              {d.evidence.map((e) => (
                <tr key={e.projectId}>
                  <td className="py-1.5 pr-4 pl-3">
                    <span className="flex items-center gap-2">
                      {faces[e.projectId]}
                      {e.title}
                    </span>
                  </td>
                  {/* the same values on every row (that is the finding): phones keep only the move */}
                  <td className="py-1.5 pr-3 font-mono tnum max-sm:hidden">
                    {e.values.join(" / ")}
                  </td>
                  <td className="py-1.5 pr-3 text-ink-2 tnum">
                    rank {rank(e.from)} → {rank(e.to)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-3">
          <p className="text-14 leading-6">
            <strong>
              Leaving {first} out moves {d.movesIfOut} of {d.of} projects.
            </strong>{" "}
            {d.biggest
              ? `The largest: ${d.biggest.title}, rank ${rank(d.biggest.from)} → ${rank(d.biggest.to)}. `
              : ""}
            Identical scores on every project carry no ranking information, so
            the rule sets this judge aside. You can reinstate them, with a
            reason.
          </p>
          {d.resolved ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-13 text-ink-2">
                Your reason: “{d.resolved.reason}”
              </p>
              {published ? null : (
                <OneClick
                  label="Undo"
                  variant="outline"
                  action={undoOverrideAction}
                  fields={{ judge: d.judgeId }}
                  eventSlug={eventSlug}
                />
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              <OneClick
                label={`Keep ${first} left out`}
                action={overrideAction}
                fields={{
                  judge: d.judgeId,
                  mode: "exclude",
                  reason: `Confirmed the flat-judge rule: ${d.vector.join("/")} on all ${d.reviews} projects.`,
                }}
                eventSlug={eventSlug}
              />
              <WithReason
                label="Reinstate, with a reason…"
                submit="Reinstate"
                action={overrideAction}
                hidden={{ judge: d.judgeId, mode: "include" }}
                eventSlug={eventSlug}
              />
            </div>
          )}
        </div>
      </div>
    );
  }
  if (d.kind === "duplicate") {
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <ul className="flex flex-col gap-2 self-start rounded-sm bg-sunken p-3 text-13">
          {d.copies.map((c) => (
            <li key={c.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
              <span className="pt-0.5">{faces[c.id]}</span>
              <span className="min-w-0">
              <span className="font-mono">{c.id}</span> · submitted{" "}
              {c.submittedAt ? formatUtc(c.submittedAt) : "–"} · {c.n} {c.n === 1 ? "review" : "reviews"}
              {c.repoUrl ? (
                <span className="block truncate text-ink-2">{c.repoUrl}</span>
              ) : null}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-3">
          <p className="text-14 leading-6">
            <strong>Merged, the engine counts one project.</strong> The copy you
            keep inherits the other&rsquo;s reviews; a judge who scored both
            counts once; no score is deleted and both copies stay in the raw
            table. Which copy you keep does not change the merged result, so
            scores are hidden here.
          </p>
          {d.resolved === "merged" ? (
            published ? null : (
              <div className="flex flex-wrap items-center gap-3">
                {d.copies
                  .filter((c) => c.duplicateOf !== null)
                  .map((c) => (
                    <OneClick
                      key={c.id}
                      label={d.copies.length > 2 ? `Undo: count ${c.id} again` : "Undo the merge"}
                      variant="outline"
                      action={unmergeAction}
                      fields={{ duplicate: c.id }}
                      eventSlug={eventSlug}
                    />
                  ))}
              </div>
            )
          ) : d.resolved === "not_duplicates" ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-13 text-ink-2">Ruled different projects; the reason is in the audit log.</p>
              {published ? null : (
                <OneClick label="Undo" variant="outline" action={undoNotDuplicateAction} fields={{ ids: d.copies.map((c) => c.id) }} eventSlug={eventSlug} />
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-3">
              {d.copies.slice(0, 2).map((c, i) => {
                const other = d.copies[1 - i]!;
                return (
                  <OneClick
                    key={c.id}
                    label={`Keep ${c.id}, merge ${other.id}`}
                    variant={i === 0 ? "primary" : "outline"}
                    action={mergeAction}
                    fields={{ keep: c.id, duplicate: other.id }}
                    eventSlug={eventSlug}
                  />
                );
              })}
              <WithReason
                label="They are different projects…"
                submit="Keep both"
                action={notDuplicateAction}
                hidden={{ ids: d.copies.map((c) => c.id) }}
                eventSlug={eventSlug}
              />
            </div>
          )}
        </div>
      </div>
    );
  }
  if (d.kind === "coin_flip_judge") {
    const first = d.name.split(" ")[0];
    return (
      <div className="flex flex-col gap-3">
        <p className="text-14 leading-6">
          <strong>
            {d.name} answered {d.picks} questions
            {d.share === null ? "" : `; weighted by how sure everyone else is, ${Math.round(d.share * 100)} % of them agree with the others`}
            {d.ties ? `, and ${d.ties} were “too close to call”` : ""}.
          </strong>{" "}
          {d.why === "ties"
            ? "Calling most pairs too close says little about which project is better. "
            : "Answers given at random would agree 50 % of the time; these do no better. "}
          Their answers still count until you decide. The flag also catches about one honest judge in eleven (JUDGING.md), so look at
          their answers on the Results page before you leave anyone out.
        </p>
        {d.resolved ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-13 text-ink-2">Your reason: “{d.resolved.reason}”</p>
            {published ? null : <OneClick label="Undo" variant="outline" action={undoOverrideAction} fields={{ judge: d.judgeId }} eventSlug={eventSlug} />}
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-3">
            <WithReason label={`Leave ${first} out, with a reason…`} submit="Leave out" action={overrideAction} hidden={{ judge: d.judgeId, mode: "exclude" }} eventSlug={eventSlug} />
            <WithReason label={`Keep ${first}, with a reason…`} submit="Keep" action={overrideAction} hidden={{ judge: d.judgeId, mode: "include" }} eventSlug={eventSlug} />
          </div>
        )}
      </div>
    );
  }
  const pw = d.mode === "pairwise";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-14 leading-6">
        <strong>
          {pw
            ? `${d.title} (${d.trackName}) was compared by ${d.n} ${d.n === 1 ? "judge" : "judges"}; a fair place needs at least 2.`
            : `${d.title} (${d.trackName}) has ${d.n} counted ${d.n === 1 ? "review" : "reviews"}; a fair score needs at least 2.`}
        </strong>{" "}
        Its {pw ? "place" : "score"} rests on{" "}
        {d.n === 1 ? "one judge's opinion" : "too few opinions"}, so its rank
        can be off by several places. A top-up assigns more judges to every project
        still short of reviews, this one included, each from its own track; the decision settles itself once {pw ? "they have placed it" : "their reviews are finished"}.
      </p>
      {d.resolved ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-13 text-ink-2">It will be published as it is, marked; the reason is in the audit log.</p>
          {published ? null : <OneClick label="Undo" variant="outline" action={undoAcceptAction} fields={{ project: d.projectId }} eventSlug={eventSlug} />}
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          <OneClick
            label="Top up every project short of reviews"
            action={topUpAction}
            fields={{ project: d.projectId }}
            eventSlug={eventSlug}
          />
          <WithReason
            label="Publish it as it is, marked…"
            submit="Publish as it is"
            action={acceptAction}
            hidden={{ project: d.projectId }}
            eventSlug={eventSlug}
          />
        </div>
      )}
    </div>
  );
}

function titleOf(c: TrackCloseCall, id: string | undefined): string {
  return c.projects.find((p) => p.id === id)?.title ?? id ?? "";
}

/**
 * "Tide Clock 3.91 ± 0.22, Lantern Map 3.84 ± 0.25": the close projects in score order, each with its score and ±
 * as every score on the page shows. Never a chance of being first: the portal shows no prize odds (JUDGING.md).
 */
export function closeLine(c: TrackCloseCall): string {
  return c.projects
    .filter((p) => c.close.includes(p.id))
    .map((p) => `${p.title} ${p.score.toFixed(2)} ± ${p.se.toFixed(2)}`)
    .join(", ");
}

/**
 * One track's close call: the close projects with their scores, and the two audited choices,
 * keep the ranking's winner or record the judges' decision with a reason. On scores without a
 * signal it only advises, so keeping needs no click. The Overview's decisions and the Results page share it.
 */
export function CloseCallBody({
  c,
  eventSlug,
  published,
  explain = true,
}: {
  c: TrackCloseCall & { resolved?: "kept" | "judges" | null };
  eventSlug: string;
  published: boolean;
  /** the Results page lists every close track and says what the figures mean once, above them */
  explain?: boolean;
}) {
  const [choosing, setChoosing] = useState(false);
  const [state, form, pending] = useFormAction(judgesDecisionAction, idle);
  const opener = useRef<HTMLButtonElement>(null);
  useRescueFocus(() => opener.current, choosing);
  // an exact tie at the top is a joint first place: say so, not "the winner, A and B"; when the event's tie-break splits
  // it, name what keeping really publishes, the tie-break's winner 1st alone, with the tie-break named
  const tb = c.tieBroken;
  const leader =
    c.top.length === 1
      ? titleOf(c, c.top[0])
      : tb
        ? `${titleOf(c, tb.winnerId)} (tie with ${c.top.filter((id) => id !== tb.winnerId).map((id) => titleOf(c, id)).join(" and ")} broken by ${tb.criterion})`
        : `${c.top.map((id) => titleOf(c, id)).join(" and ")}, tied`;
  const others = c.projects.filter((p) => c.close.includes(p.id) && !(c.top.length === 1 && p.id === c.top[0]));
  const settledNow = c.choice !== null && c.stale === null;
  // a choice can be made only while the track is too close to call: once the scores name the winner (or fewer than two
  // projects are ranked), keeping or recording would be refused, so only the undo is offered
  const choosable = c.projects.length > 0 && !c.callable;
  return (
    <div className={explain ? "flex flex-col gap-3" : "flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-x-6"}>
      {explain ? null : (
        <p className="text-14 leading-6 md:min-w-0 md:flex-1">
          <strong>
            {c.callable ? "Clear from the scores now: " : ""}
            {closeLine(c)}.
          </strong>{" "}
          Ranking&rsquo;s winner: {leader}.
        </p>
      )}
      {explain ? (
      <p className="text-14 leading-6">
        <strong>{choosable || published ? "Too close to call from the scores" : "Clear from the scores now"}: {closeLine(c)}.</strong>{" "}
        Each is a score and its ±. The scores name a winner only when the ranking&rsquo;s first comes out first in at least 95 % of 4,000 draws within
        the ± (JUDGING.md, &ldquo;Close calls&rdquo;); these are the fewest projects that together come out first in 95 % of them.{" "}
        {published || !choosable
          ? ""
          : c.signal
          ? `Keep the ranking's winner, ${leader}, or record the judges' decision: after they deliberate, they name the winner among these projects, with the reason.`
          : `The signal check finds that the scores cannot tell these projects apart, so this is advice, not a decision you must make: the ranking's winner, ${leader}, stands unless you record the judges' decision.`}{" "}
        {published || !choosable ? null : (
          <>
            A judges&rsquo; decision puts their winner first on the published results, marked &ldquo;Winner by the judges&rsquo; decision&rdquo; with the reason, and
            the score order stays shown.
          </>
        )}
      </p>
      ) : null}
      {c.stale && c.choice ? (
        <p className="basis-full text-13 text-flag">
          Your earlier choice ({c.choice.mode === "keep" ? "keep the ranking's winner" : `the judges named ${titleOf(c, c.choice.winnerId)}`}) no longer fits: {c.stale}.
          {choosable ? " Choose again, or undo it." : " There is no close call left to settle here, so undo it to clear it."}
        </p>
      ) : null}
      {settledNow ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-13 text-ink-2">
            {c.choice!.mode === "keep"
              ? `Kept: ${leader} is published as the winner.`
              : `The judges' decision: ${titleOf(c, c.choice!.winnerId)} wins. Their reason: “${c.choice!.reason ?? ""}”`}
          </p>
          {published ? null : (
            <OneClick label="Undo" variant="outline" action={undoCloseCallAction} fields={{ track: c.trackId }} eventSlug={eventSlug} />
          )}
        </div>
      ) : published ? (
        <p className="text-13 text-ink-2">Published with the ranking&rsquo;s winner, {leader}.</p>
      ) : (
        <div className={`flex flex-wrap items-start gap-3 ${choosing ? "basis-full" : ""}`}>
          {choosable && (c.signal || c.choice) ? (
            <OneClick label={`Keep the ranking's winner, ${leader}`} action={keepRankingAction} fields={{ track: c.trackId }} eventSlug={eventSlug} />
          ) : null}
          {choosable && others.length > 0 && !choosing ? (
            <Button ref={opener} type="button" variant="outline" onClick={() => setChoosing(true)}>
              Record the judges&rsquo; decision…
            </Button>
          ) : null}
          {c.stale && c.choice ? (
            <OneClick label="Undo my earlier choice" variant="outline" action={undoCloseCallAction} fields={{ track: c.trackId }} eventSlug={eventSlug} />
          ) : null}
          {choosable && others.length > 0 && choosing ? (
            <form {...form} className="flex w-full flex-col gap-3">
              <input type="hidden" name="event" value={eventSlug} />
              <input type="hidden" name="track" value={c.trackId} />
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-13 font-medium">The winner the judges named</legend>
                {others.map((p, i) => (
                  <label
                    key={p.id}
                    className="flex items-start gap-3 rounded-sm border border-edge px-3 py-2.5 has-[:checked]:border-accent has-[:checked]:bg-accent-tint"
                  >
                    {/* the button that opened the form is gone: focus starts on the first choice, as the reason boxes start on theirs */}
                    <input type="radio" name="winner" value={p.id} required autoFocus={i === 0} className="mt-1 size-4 accent-[var(--primary)]" />
                    <span>
                      <span className="block text-14 font-medium">{p.title}</span>
                      <span className="block text-13 text-ink-2 tnum">
                        score {p.score.toFixed(2)} ± {p.se.toFixed(2)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {state.fieldErrors?.winnerId ? <p className="text-13 text-flag">{state.fieldErrors.winnerId[0]}</p> : null}
              <label className="text-13 font-medium" htmlFor={`reason-close-${c.trackId}`}>
                The judges&rsquo; reason, shown on the public results
              </label>
              <Textarea
                id={`reason-close-${c.trackId}`}
                name="reason"
                rows={2}
                aria-invalid={Boolean(state.fieldErrors?.reason)}
              />
              <div className="flex items-center gap-3">
                <Button disabled={pending}>{pending ? "Recording…" : "Record the judges’ decision"}</Button>
                <Button type="button" variant="ghost" onClick={() => setChoosing(false)}>
                  Cancel
                </Button>
              </div>
              <Result state={state} />
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function Decisions({
  eventSlug,
  decisions,
  faces,
  published,
}: {
  eventSlug: string;
  decisions: Decision[];
  faces: Record<string, React.ReactNode>;
  /** once published the list is a record: it counts the decisions made and offers no Undo */
  published: boolean;
}) {
  const firstOpen = decisions.find((d) => !d.resolved)?.key ?? null;
  const [open, setOpen] = useState<string | null>(firstOpen);
  // Making or undoing a decision swaps its form for the result: focus lands back on its row.
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  useRescueFocus(() => (open ? rowButtons.current.get(open) : undefined), decisions.map((d) => `${d.key}:${d.resolved}`).join("|"));
  const openCount = decisions.filter((d) => !d.resolved).length;
  const count = published ? decisions.length : openCount;
  return (
    <section
      aria-labelledby="decisions-title"
      data-wire-from=""
      className="min-w-0 rounded-sm border border-rule bg-surface p-6 wrap-anywhere lg:col-span-2"
    >
      <div className="flex items-start gap-5">
        <span
          className={`font-display text-[64px] leading-[56px] sm:text-[96px] sm:leading-[80px] ${!published && count ? "text-flag-bar" : "text-ok"}`}
          aria-hidden
        >
          {count}
        </span>
        <div>
          <h2
            id="decisions-title"
            className="text-24 font-semibold sm:text-[32px] sm:leading-[38px]"
          >
            <span className="sr-only">{count} </span>
            {published
              ? decisions.length
                ? `${decisions.length === 1 ? "decision" : "decisions"} made before publishing`
                : "decisions needed: nothing was flagged"
              : count === 0
              ? decisions.length
                ? "decisions left: results can go out"
                : "decisions needed: nothing is flagged"
              : `${count === 1 ? "decision" : "decisions"} before results can go out`}
          </h2>
          <p className="mt-2 text-14 text-ink-2">
            Each is logged with who decided, when and why.{" "}
            {published
              ? "The results are published, so the decisions are final."
              : `Nothing is published until ${decisions.length === 1 ? "it is" : "all of them are"} made.`}
          </p>
        </div>
      </div>
      {decisions.length ? (
        <ol className="mt-6 border-t border-rule">
          {decisions.map((d, i) => {
            const expanded = open === d.key;
            const ids =
              d.kind === "flat_judge"
                ? d.evidence.map((e) => e.projectId)
                : d.kind === "duplicate"
                  ? d.copies.map((c) => c.id)
                  : d.kind === "coin_flip_judge"
                    ? []
                    : d.kind === "close_call"
                      ? d.close
                      : [d.projectId];
            return (
              <li
                key={d.key}
                className={`relative border-b border-rule ${d.resolved ? "" : "before:absolute before:top-3 before:bottom-3 before:-left-6 before:w-[3px] before:bg-flag-bar"}`}
              >
                <button
                  ref={(el) => {
                    if (el) rowButtons.current.set(d.key, el);
                    else rowButtons.current.delete(d.key);
                  }}
                  type="button"
                  data-wire-source=""
                  data-open={d.resolved ? "false" : "true"}
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : d.key)}
                  className="grid w-full grid-cols-[28px_120px_minmax(0,1fr)_auto] items-center gap-3 py-3 text-left max-md:grid-cols-[28px_minmax(0,1fr)_auto]"
                >
                  <span className="text-14 text-ink-2 tnum">
                    {d.resolved ? (
                      <>
                        <Check className="size-4 text-ok" aria-hidden />
                        <span className="sr-only">{i + 1}, settled</span>
                      </>
                    ) : (
                      `${i + 1}.`
                    )}
                  </span>
                  <span className="font-mono text-12 text-ink-2 max-md:hidden">
                    {d.kind === "under_reviewed" && d.mode === "pairwise" ? "06 Comparing" : STAGE[d.kind]}
                  </span>
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      className={`text-15 sm:truncate ${d.resolved ? "font-medium text-ink-2" : "font-semibold"}`}
                    >
                      {sentence(d)}
                    </span>
                    <span className="flex shrink-0 gap-1 max-lg:hidden">
                      {ids.map((id) => (
                        <span key={id}>{faces[id]}</span>
                      ))}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-13 text-ink-2">
                    <span className={`max-sm:hidden ${d.resolved ? "font-medium text-ok" : ""}`}>{stateLine(d)}</span>
                    {expanded ? (
                      <ChevronDown className="size-4" aria-hidden />
                    ) : (
                      <ChevronRight className="size-4" aria-hidden />
                    )}
                  </span>
                </button>
                {expanded ? (
                  <div className="pb-5 pl-[40px]">
                    <Body d={d} eventSlug={eventSlug} published={published} faces={faces} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

export function PublishPanel({
  eventSlug,
  open,
  total,
  publishedAt,
  submissionsCloseAt,
  pairwise = false,
  unsettled = null,
  vote = null,
  prizes = null,
  receipt = [],
}: {
  eventSlug: string;
  open: number;
  total: number;
  publishedAt: string | null;
  /** the event is judged pairwise: publishing stores a pairwise run */
  pairwise?: boolean;
  /** a pairwise ranking fit that stopped at its step limit before settling: publishing then needs a reason */
  unsettled?: { iterations: number } | null;
  /** set while submissions are still open: publishing waits for the close */
  submissionsCloseAt: string | null;
  /** the community vote: publishing closes an open one and calls off one not yet open */
  vote?: { state: "not_set" | "upcoming" | "open" | "closed"; opensAt: string | null; closesAt: string | null; ballots: number } | null;
  /** the event's prizes and how many are awarded; null when it has none. Not a blocker: an unawarded prize stays unawarded */
  prizes?: { total: number; awarded: number } | null;
  /** once published: what went out, one line each, every value from the data layer */
  receipt?: { label: string; value: string; href?: string }[];
}) {
  const [state, form, pending] = useFormAction(publishAction, idle);
  const decided = total - open;
  // Publishing replaces the form, so focus would fall to the page: land on "Published".
  const publishedHeading = useRef<HTMLHeadingElement>(null);
  useRescueFocus(() => publishedHeading.current, publishedAt);
  return (
    <section
      aria-labelledby="publish-title"
      data-wire-panel=""
      className="flex flex-col gap-4 self-start rounded-sm border border-rule bg-surface p-6"
    >
      <p className="label-mono text-ink-2">Results</p>
      {publishedAt ? (
        <>
          <h2
            ref={publishedHeading}
            tabIndex={-1}
            id="publish-title"
            className="flex items-center gap-3 text-24 font-semibold"
          >
            <span data-wire-target="" aria-hidden className="inline-flex size-9 items-center justify-center border-2 border-ink">
              <LockOpen className="size-5" />
            </span>{" "}
            Published
          </h2>
          <p className="text-14 text-ink-2">
            Since {formatUtc(publishedAt)}. The results page is public, each
            team sees its written feedback, and scoring is frozen.
          </p>
          {receipt.length ? (
            <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 border-t border-rule text-13">
              {receipt.map((r) => (
                <div key={r.label} className="col-span-2 grid grid-cols-subgrid border-b border-rule py-2">
                  <dt className="text-ink-2">{r.label}</dt>
                  <dd className="text-ink tnum">
                    {r.href ? (
                      <Link href={r.href} className="underline underline-offset-4">
                        {r.value}
                      </Link>
                    ) : (
                      r.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Link
            href={`/events/${eventSlug}/results`}
            className="text-14 underline underline-offset-4"
          >
            Open the public results
          </Link>
        </>
      ) : (
        <>
          <h2
            id="publish-title"
            className="flex items-center gap-3 text-24 font-semibold"
          >
            {/* the terminal the overview's decision wires run into: orange while any is open */}
            <span
              data-wire-target=""
              aria-hidden
              className={`inline-flex size-9 items-center justify-center border-2 ${open || submissionsCloseAt ? "border-flag-bar" : "border-ink"}`}
            >
              {submissionsCloseAt ? <Clock className="size-5" /> : open ? <Lock className="size-5" /> : <LockOpen className="size-5" />}
            </span>
            {submissionsCloseAt ? "After the close" : open ? "Locked" : "Ready"}
          </h2>
          {total ? (
            // the lock's own progress, read with the heading: one cell per decision in the
            // Judges figure's language, filled ink when made, a dashed orange outline (the
            // open wires' colour) while it waits
            <div className="flex flex-col gap-1.5">
              <span className="flex gap-[3px]" aria-hidden>
                {Array.from({ length: total }, (_, i) => (
                  <span
                    key={i}
                    className={`h-4 flex-1 border ${i < decided ? "border-ink bg-ink" : "border-dashed border-flag-bar"}`}
                  />
                ))}
              </span>
              <span className="text-13 text-ink-2 tnum">
                {decided} of {total} decided
              </span>
            </div>
          ) : null}
          <form {...form} className="flex flex-col gap-3">
            <input type="hidden" name="event" value={eventSlug} />
            {vote && (vote.state === "open" || vote.state === "upcoming") ? (
              <p className="rounded-sm border border-rule border-l-[3px] border-l-flag-bar p-3 text-14">
                {vote.state === "open"
                  ? `The community vote is open until ${formatUtc(vote.closesAt)}; ${votersIn(vote.ballots)}. Publishing closes it: its count becomes final and public with the results, so nobody votes with the ranking in view.`
                  : `A community vote is set to open ${formatUtc(vote.opensAt)}. Publishing calls it off, so nobody votes with the ranking in view.`}
              </p>
            ) : null}
            {prizes && prizes.awarded < prizes.total ? (
              <p className="rounded-sm border border-rule border-l-[3px] border-l-flag-bar p-3 text-14">
                {prizes.total - prizes.awarded === prizes.total
                  ? `No prize is awarded yet (${prizes.total === 1 ? "the event has one" : `the event has ${prizes.total}`}). `
                  : `${prizes.total - prizes.awarded} of ${prizes.total} prizes ${prizes.total - prizes.awarded === 1 ? "is" : "are"} not awarded yet. `}
                You can publish anyway: {prizes.total - prizes.awarded === 1 ? "it stays" : "they stay"} unawarded, and publishing makes the prizes final.{" "}
                <Link href={`/organize/${eventSlug}/results#prizes-title`} className="underline underline-offset-4">
                  Award prizes
                </Link>
              </p>
            ) : null}
            {unsettled && !open && !submissionsCloseAt ? (
              <div className="flex flex-col gap-2 rounded-sm border border-rule border-l-[3px] border-l-flag-bar p-3 text-14">
                <p>
                  The ranking fit did not settle within {unsettled.iterations} steps, so its win % may still move. More comparisons usually settle it: ask
                  the judges to finish placing their projects. To publish it as it is, say why; the reason goes on the published results.
                </p>
                <label className="text-13 font-medium" htmlFor="publish-reason">
                  Reason, for the results and the audit log
                </label>
                <Textarea id="publish-reason" name="reason" rows={2} aria-invalid={Boolean(state.fieldErrors?.reason)} />
              </div>
            ) : null}
            {open || submissionsCloseAt ? null : (
              <label className="flex items-start gap-2 text-14">
                <input
                  type="checkbox"
                  name="confirm"
                  value="yes"
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                I have read the ranking and want it public now.
              </label>
            )}
            <Button size="xl" disabled={open > 0 || Boolean(submissionsCloseAt) || pending} className="w-full">
              {pending ? "Publishing…" : "Publish results"}
            </Button>
            <p className="text-center text-13 text-ink-2">
              {submissionsCloseAt
                ? `Submissions are open until ${formatUtc(submissionsCloseAt)}; results can be published once they close.`
                : open
                  ? `Make the ${open === 1 ? "last decision" : `${open} decisions`} first`
                  : "Every decision is made."}
            </p>
            <Result state={state} />
          </form>
          <p className="text-13 text-ink-2">
            Publishing makes the results page public, shows each team its
            written feedback, and freezes {pairwise ? "judging" : "scoring"}. It is logged, with the
            {pairwise ? " pairwise" : " normalization"} run it publishes.
          </p>
          <Link
            href={`/organize/${eventSlug}/results`}
            className="text-14 underline underline-offset-4"
          >
            Preview the ranking and how it is worked out
          </Link>
        </>
      )}
    </section>
  );
}
