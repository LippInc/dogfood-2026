"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import {
  assignByHandAction,
  inviteJudgeAction,
  runAssignmentAction,
  setTracksAction,
  type InviteResult,
  type RunResult,
} from "./actions";

type Track = { id: string; name: string };

export function CopyButton({ text, label = "Copy", done = "Copied" }: { text: string; label?: string; done?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Copy this:", text);
        }
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      <span aria-live="polite">{copied ? done : label}</span>
    </Button>
  );
}

function TrackBoxes({ tracks, name, checked = [] }: { tracks: Track[]; name: string; checked?: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
      {tracks.map((t) => (
        <label key={t.id} className="flex items-center gap-2 text-14">
          <input type="checkbox" name={name} value={t.id} defaultChecked={checked.includes(t.id)} className="size-4 accent-[var(--primary)]" />
          {t.name}
        </label>
      ))}
    </div>
  );
}

export function InviteForm({ eventSlug, tracks }: { eventSlug: string; tracks: Track[] }) {
  const [state, action, pending] = useFormAction<InviteResult>(inviteJudgeAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  const link = state.path && typeof window !== "undefined" ? `${window.location.origin}${state.path}` : state.path;
  return (
    <form {...action} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="event" value={eventSlug} />
      <Field id="invite-name" label="Name" help="How the judge appears to you. Optional." error={e.name}>
        {(a) => <Input {...a} name="name" maxLength={80} />}
      </Field>
      <Field id="invite-email" label="Email" help="Only this address can use the link. Leave empty for a link anyone can use once." error={e.email}>
        {(a) => <Input {...a} name="email" type="email" inputMode="email" />}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-14 font-medium">Tracks they judge</legend>
        <TrackBoxes tracks={tracks} name="trackIds" />
        {e.trackIds ? <p className="text-13 text-flag">{e.trackIds[0]}</p> : null}
      </fieldset>
      <div className="flex items-center gap-3">
        <Button disabled={pending}>{pending ? "Making the link…" : "Make invitation link"}</Button>
      </div>
      {state.ok && link ? (
        <div className="flex flex-col gap-2 rounded-sm border border-rule bg-sunken p-3">
          <p className="text-13 text-ink-2">{state.message}</p>
          <p className="font-mono text-12 break-all">{link}</p>
          <CopyButton text={link} label="Copy link" />
        </div>
      ) : state.message ? (
        <p role="status" className="text-13 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function TracksForm({ eventSlug, judgeId, tracks, checked }: { eventSlug: string; judgeId: string; tracks: Track[]; checked: string[] }) {
  const [state, action, pending] = useFormAction<ActionResult>(setTracksAction, { ok: false, message: null });
  return (
    <form {...action} className="flex flex-col gap-3 pt-3">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="judge" value={judgeId} />
      <TrackBoxes tracks={tracks} name="trackIds" checked={checked} />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending}>
          Save tracks
        </Button>
        {state.message ? <span className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>{state.message}</span> : null}
      </div>
    </form>
  );
}

export function RunForm({ eventSlug, hasAssignments, target }: { eventSlug: string; hasAssignments: boolean; target: number }) {
  const [state, action, pending] = useFormAction<RunResult>(runAssignmentAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form {...action} className="flex flex-col gap-4">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="mode" value={hasAssignments ? "topup" : "fresh"} />
      <div className="grid grid-cols-2 gap-3">
        <Field id="reviewsPerProject" label="Reviews per project" error={e.reviewsPerProject}>
          {(a) => <Input {...a} name="reviewsPerProject" type="number" min={1} max={10} defaultValue={target} />}
        </Field>
        {hasAssignments ? null : (
          <Field id="bridgePerTrack" label="Bridge per track" help="For judges with two tracks" error={e.bridgePerTrack}>
            {(a) => <Input {...a} name="bridgePerTrack" type="number" min={0} max={5} defaultValue={2} />}
          </Field>
        )}
      </div>
      <Field id="seed" label="Seed" help="Leave empty for a new one. The same seed on the same data gives the same assignment." error={e.seed}>
        {(a) => <Input {...a} name="seed" inputMode="numeric" placeholder="random" />}
      </Field>
      <div className="flex items-center gap-3">
        <Button disabled={pending}>{pending ? "Assigning…" : hasAssignments ? "Run a top-up" : "Assign judges"}</Button>
      </div>
      {state.message ? (
        <p role="status" className={`text-13 ${state.ok ? "text-ink" : "text-flag"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function ByHandForm({
  eventSlug,
  projectId,
  judges,
}: {
  eventSlug: string;
  projectId: string;
  judges: { id: string; name: string; inTrack: boolean }[];
}) {
  const [state, action, pending] = useFormAction<ActionResult>(assignByHandAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form {...action} className="flex flex-col gap-3 pt-3">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="project" value={projectId} />
      <label className="text-14 font-medium" htmlFor={`judge-${projectId}`}>
        Judge
      </label>
      <select id={`judge-${projectId}`} name="judge" className="h-10 rounded-sm border border-edge bg-surface px-3 text-15" defaultValue="">
        <option value="" disabled>
          Choose a judge
        </option>
        {judges.map((j) => (
          <option key={j.id} value={j.id}>
            {j.name}
            {j.inTrack ? "" : " (another track)"}
          </option>
        ))}
      </select>
      <label className="text-14 font-medium" htmlFor={`reason-${projectId}`}>
        Reason, for the audit log
      </label>
      <Textarea id={`reason-${projectId}`} name="reason" rows={2} aria-invalid={Boolean(e.reason)} />
      {e.reason ? <p className="text-13 text-flag">{e.reason[0]}</p> : null}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending}>
          Assign by hand
        </Button>
        {state.message ? <span className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>{state.message}</span> : null}
      </div>
    </form>
  );
}
