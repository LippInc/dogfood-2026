"use client";

import { ChevronDown, ChevronRight, Lock, LockOpen } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatUtc } from "@/lib/format";
import type { ActionResult, Decision } from "@/server/dal";
import {
  acceptAction,
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
  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
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
  if (d.kind === "flat_judge")
    return `${d.name} scored every project ${d.vector.join(" / ")}`;
  if (d.kind === "duplicate")
    return `${d.title} was entered ${d.copies.length === 2 ? "twice" : `${d.copies.length} times`} by ${d.team}`;
  return `${d.title} has ${d.n} counted ${d.n === 1 ? "review" : "reviews"}`;
}

function stateLine(d: Decision): string {
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
  if (d.resolved) return "Publishing as it is";
  return d.waiting
    ? `${d.waiting} more assigned, not finished`
    : "Minimum is 2";
}

function Body({ d, eventSlug }: { d: Decision; eventSlug: string }) {
  if (d.kind === "flat_judge") {
    const first = d.name.split(" ")[0];
    return (
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="self-start overflow-x-auto">
          <table className="rounded-sm bg-sunken text-13 whitespace-nowrap">
            <tbody>
              {d.evidence.map((e) => (
                <tr key={e.projectId}>
                  <td className="py-1.5 pr-4 pl-3">{e.title}</td>
                  <td className="py-1.5 pr-3 font-mono tnum">
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
              <OneClick
                label="Undo"
                variant="outline"
                action={undoOverrideAction}
                fields={{ judge: d.judgeId }}
                eventSlug={eventSlug}
              />
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
            <li key={c.id}>
              <span className="font-mono">{c.id}</span> · submitted{" "}
              {c.submittedAt ? formatUtc(c.submittedAt) : "–"}
              {c.repoUrl ? (
                <span className="block truncate text-ink-2">{c.repoUrl}</span>
              ) : null}
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
            <div className="flex flex-wrap items-center gap-3">
              {d.copies
                .filter((c) => c.id !== d.keptId)
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
          ) : d.resolved === "not_duplicates" ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-13 text-ink-2">Ruled different projects; the reason is in the audit log.</p>
              <OneClick label="Undo" variant="outline" action={undoNotDuplicateAction} fields={{ ids: d.copies.map((c) => c.id) }} eventSlug={eventSlug} />
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
  return (
    <div className="flex flex-col gap-3">
      <p className="text-14 leading-6">
        <strong>
          {d.title} ({d.trackName}) has {d.n} counted{" "}
          {d.n === 1 ? "review" : "reviews"}; a fair score needs at least 2.
        </strong>{" "}
        Its score rests on{" "}
        {d.n === 1 ? "one judge's opinion" : "too few opinions"}, so its rank
        can be off by several places. A top-up assigns more judges from its own
        track; the decision settles itself once their reviews are finished.
      </p>
      {d.resolved ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-13 text-ink-2">It will be published as it is, marked; the reason is in the audit log.</p>
          <OneClick label="Undo" variant="outline" action={undoAcceptAction} fields={{ project: d.projectId }} eventSlug={eventSlug} />
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-3">
          <OneClick
            label="Assign more reviews (top-up)"
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

export function Decisions({
  eventSlug,
  decisions,
  faces,
}: {
  eventSlug: string;
  decisions: Decision[];
  faces: Record<string, React.ReactNode>;
}) {
  const firstOpen = decisions.find((d) => !d.resolved)?.key ?? null;
  const [open, setOpen] = useState<string | null>(firstOpen);
  const count = decisions.filter((d) => !d.resolved).length;
  return (
    <section
      aria-labelledby="decisions-title"
      className="rounded-sm border border-rule bg-surface p-6 lg:col-span-2"
    >
      <div className="flex items-start gap-5">
        <span
          className={`font-display text-[96px] leading-[80px] ${count ? "text-flag-bar" : "text-ok"}`}
          aria-hidden
        >
          {count}
        </span>
        <div>
          <h2
            id="decisions-title"
            className="text-[32px] leading-[38px] font-semibold"
          >
            <span className="sr-only">{count} </span>
            {count === 0
              ? decisions.length
                ? "decisions left: results can go out"
                : "decisions needed: nothing is flagged"
              : `${count === 1 ? "decision" : "decisions"} before results can go out`}
          </h2>
          <p className="mt-2 text-14 text-ink-2">
            Each is logged with who decided, when and why. Nothing is published
            until {decisions.length === 1 ? "it is" : "all of them are"} made.
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
                  : [d.projectId];
            return (
              <li key={d.key} className="border-b border-rule">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : d.key)}
                  className="grid w-full grid-cols-[28px_120px_minmax(0,1fr)_auto] items-center gap-3 py-3 text-left max-md:grid-cols-[28px_minmax(0,1fr)_auto]"
                >
                  <span className="text-14 text-ink-2 tnum">{i + 1}.</span>
                  <span className="font-mono text-12 text-ink-2 max-md:hidden">
                    {STAGE[d.kind]}
                  </span>
                  <span className="flex min-w-0 items-center gap-3">
                    <span
                      className={`truncate text-15 font-semibold ${d.resolved ? "text-ink-2 line-through decoration-ink-3" : ""}`}
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
                    <span className="max-sm:hidden">{stateLine(d)}</span>
                    {expanded ? (
                      <ChevronDown className="size-4" aria-hidden />
                    ) : (
                      <ChevronRight className="size-4" aria-hidden />
                    )}
                  </span>
                </button>
                {expanded ? (
                  <div className="pb-5 pl-[40px]">
                    <Body d={d} eventSlug={eventSlug} />
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
}: {
  eventSlug: string;
  open: number;
  total: number;
  publishedAt: string | null;
}) {
  const [state, form, pending] = useFormAction(publishAction, idle);
  const decided = total - open;
  return (
    <section
      aria-labelledby="publish-title"
      className="flex flex-col gap-4 self-start rounded-sm border border-rule bg-surface p-6"
    >
      <p className="label-mono text-ink-2">Results</p>
      {publishedAt ? (
        <>
          <h2
            id="publish-title"
            className="flex items-center gap-2 text-24 font-semibold"
          >
            <LockOpen className="size-5" aria-hidden /> Published
          </h2>
          <p className="text-14 text-ink-2">
            Since {formatUtc(publishedAt)}. The results page is public, each
            team sees its written feedback, and scoring is frozen.
          </p>
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
            className="flex items-center gap-2 text-24 font-semibold"
          >
            {open ? (
              <Lock className="size-5" aria-hidden />
            ) : (
              <LockOpen className="size-5" aria-hidden />
            )}
            {open ? "Locked" : "Ready"}
          </h2>
          <form {...form} className="flex flex-col gap-3">
            <input type="hidden" name="event" value={eventSlug} />
            {open ? null : (
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
            <Button size="xl" disabled={open > 0 || pending} className="w-full">
              {pending ? "Publishing…" : "Publish results"}
            </Button>
            <p className="text-center text-13 text-ink-2">
              {open
                ? `Make the ${open === 1 ? "last decision" : `${open} decisions`} first`
                : "Every decision is made."}
            </p>
            <Result state={state} />
          </form>
          {total ? (
            <div className="flex items-center gap-3">
              <span className="flex gap-1" aria-hidden>
                {Array.from({ length: total }, (_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-8 rounded-[1px] ${i < decided ? "bg-ink" : "bg-sunken"}`}
                  />
                ))}
              </span>
              <span className="text-13 text-ink-2 tnum">
                {decided} of {total} decided
              </span>
            </div>
          ) : null}
          <p className="text-13 text-ink-2">
            Publishing makes the results page public, shows each team its
            written feedback, and freezes scoring. It is logged, with the
            normalization run it publishes.
          </p>
          <Link
            href={`/organize/${eventSlug}/results`}
            className="text-14 underline underline-offset-4"
          >
            Preview the ranking and its working
          </Link>
        </>
      )}
    </section>
  );
}
