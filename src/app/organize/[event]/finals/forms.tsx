"use client";

import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/dal";
import { addFinalistAction, closeFinalsAction, openFinalsAction, panelAction, removeFinalistAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };
const SELECT = "h-10 w-full rounded-sm border border-edge bg-surface px-3 text-14";

function Status({ state }: { state: ActionResult }) {
  // the line keeps its height, so a message appearing never moves what is below it
  return (
    <p role="status" className={`min-h-5 text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
      {state.message ?? ""}
    </p>
  );
}

export function OpenFinalsForm({ eventSlug, tracks, everyTrack }: { eventSlug: string; tracks: { id: string; name: string }[]; everyTrack: boolean }) {
  const [state, form, pending] = useFormAction(openFinalsAction, idle, { resetOnSuccess: false });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="event" value={eventSlug} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px]">
        <Field id="finals-track" label="For" error={e.track}>
          {(a) => (
            <select {...a} name="track" className={SELECT} defaultValue={tracks[0]?.id ?? ""}>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              {everyTrack ? <option value="">Every track, one panel</option> : null}
            </select>
          )}
        </Field>
        <Field id="finals-n" label="Finalists per track" help="The top N by first-round places." error={e.n}>
          {(a) => <Input {...a} name="n" type="number" min={1} max={50} defaultValue={3} className="tnum" />}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Open finals
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function AddFinalistForm({
  eventSlug,
  finalsId,
  candidates,
}: {
  eventSlug: string;
  finalsId: string;
  candidates: { projectId: string; title: string; trackName: string; place: number | null; inTopN: boolean }[];
}) {
  const [state, form, pending] = useFormAction(addFinalistAction, idle);
  const [pick, setPick] = useState(candidates[0]?.projectId ?? "");
  const chosen = candidates.find((c) => c.projectId === pick);
  const e = state.fieldErrors ?? {};
  if (!candidates.length) return <p className="text-13 text-ink-2">Every ranked project of this round is a finalist.</p>;
  return (
    <form {...form} onReset={() => setPick(candidates[0]?.projectId ?? "")} className="flex flex-col gap-3">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="finals" value={finalsId} />
      <Field id={`add-${finalsId}`} label="Add a finalist" error={e.project}>
        {(a) => (
          <select {...a} name="project" className={SELECT} value={pick} onChange={(ev) => setPick(ev.currentTarget.value)}>
            {candidates.map((c) => (
              <option key={c.projectId} value={c.projectId}>
                {c.title} · {c.trackName} · {c.place === null ? "no first-round place" : `first round ${c.place}`}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        id={`add-reason-${finalsId}`}
        label={chosen && !chosen.inTopN ? "Why, against the ranking" : "Why (optional)"}
        help={chosen && !chosen.inTopN ? "It is not in its track's top places, so the audit log and the export keep your reason." : undefined}
        error={e.reason}
      >
        {(a) => <Input {...a} name="reason" maxLength={500} />}
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          Add finalist
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function RemoveFinalistForm({ eventSlug, finalsId, projectId, title, inTopN }: { eventSlug: string; finalsId: string; projectId: string; title: string; inTopN: boolean }) {
  const [state, form, pending] = useFormAction(removeFinalistAction, idle);
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-wrap items-start gap-2">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="finals" value={finalsId} />
      <input type="hidden" name="project" value={projectId} />
      {inTopN ? (
        <Input
          name="reason"
          aria-label={`Why ${title} leaves the finals`}
          placeholder="Why it leaves"
          maxLength={500}
          aria-invalid={e.reason ? true : undefined}
          className="h-9 w-44 text-13 sm:h-7"
        />
      ) : null}
      <Button type="submit" variant="ghost" size="sm" disabled={pending} aria-label={`Take ${title} off the finals`}>
        Take off
      </Button>
      {state.message && !state.ok ? <p role="status" className="basis-full text-12 text-flag">{state.message}</p> : null}
    </form>
  );
}

export function PanelForm({
  eventSlug,
  finalsId,
  judges,
  panel,
}: {
  eventSlug: string;
  finalsId: string;
  judges: { id: string; name: string }[];
  panel: { id: string; scored: number; toScore: number }[];
}) {
  const [state, form, pending] = useFormAction(panelAction, idle, { resetOnSuccess: false });
  const e = state.fieldErrors ?? {};
  const on = new Map(panel.map((p) => [p.id, p]));
  // once a panelist has scored, a change of the panel needs a reason (the results show it)
  const scoring = panel.some((p) => p.scored > 0);
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="finals" value={finalsId} />
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-2 text-14 font-medium">The panel, at least two judges</legend>
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {judges.map((j) => (
            <label key={j.id} className="flex min-h-9 items-center gap-2 text-14">
              <input type="checkbox" name="judges" value={j.id} defaultChecked={on.has(j.id)} className="size-4 accent-[var(--ink)]" />
              <span className="min-w-0 truncate">{j.name}</span>
              {on.has(j.id) ? (
                <span className="ml-auto text-12 text-ink-2 tnum">
                  {on.get(j.id)!.scored} of {on.get(j.id)!.toScore} scored
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </fieldset>
      {scoring ? (
        <Field
          id={`panel-reason-${finalsId}`}
          label="Why the panel changes"
          help="Finals scores are in: a panelist taken off stops counting. The results show your reason."
          error={e.reason}
        >
          {(a) => <Input {...a} name="reason" maxLength={500} />}
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          Save panel
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function CloseFinalsForm({ eventSlug, finalsId, missing }: { eventSlug: string; finalsId: string; missing: number }) {
  const [state, form, pending] = useFormAction(closeFinalsAction, idle, { resetOnSuccess: false });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="finals" value={finalsId} />
      {missing > 0 ? (
        <Field
          id={`close-reason-${finalsId}`}
          label="Why close before every score is in"
          help={`${missing} ${missing === 1 ? "score is" : "scores are"} still missing. The results will show your reason.`}
          error={e.reason}
        >
          {(a) => <Input {...a} name="reason" maxLength={500} />}
        </Field>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          Close finals
        </Button>
        <Status state={state} />
      </div>
    </form>
  );
}
