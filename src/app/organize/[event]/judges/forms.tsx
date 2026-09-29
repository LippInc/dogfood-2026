"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Field, FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import {
  assignByHandAction,
  emailRemindersAction,
  inviteJudgeAction,
  inviteJudgesAction,
  revokeInviteAction,
  runAssignmentAction,
  setTracksAction,
  type BatchInviteResult,
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

/**
 * Mail the reminder the copy button gives: to one judge (judge set) or to every judge who has not started. The
 * portal mails a judge at most once an hour; a refusal (too soon, email off) shows under the button.
 */
export function EmailReminder({ eventSlug, judge, label, name }: { eventSlug: string; judge?: string; label: string; name?: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(emailRemindersAction, { ok: false, message: null });
  return (
    <form {...form} className="flex flex-col items-start gap-1">
      <input type="hidden" name="event" value={eventSlug} />
      {judge ? <input type="hidden" name="judge" value={judge} /> : null}
      <Button size="sm" variant="outline" disabled={pending} aria-label={name ? `${label} to ${name}` : undefined}>
        {pending ? "Mailing…" : label}
      </Button>
      {state.message ? (
        <p role="status" className={`max-w-[320px] text-12 ${state.ok ? "text-ok" : "text-flag"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function TrackBoxes({ tracks, name, checked = [] }: { tracks: Track[]; name: string; checked?: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
      {tracks.map((t) => (
        <label key={t.id} className="flex items-center gap-2 text-14 wrap-anywhere">
          <input type="checkbox" name={name} value={t.id} defaultChecked={checked.includes(t.id)} className="size-4 shrink-0 accent-[var(--primary)]" />
          {t.name}
        </label>
      ))}
    </div>
  );
}

export function InviteForm({ eventSlug, tracks }: { eventSlug: string; tracks: Track[] }) {
  const [state, form, pending] = useFormAction<InviteResult>(inviteJudgeAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  const link = state.path && typeof window !== "undefined" ? `${window.location.origin}${state.path}` : state.path;
  return (
    <form {...form} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="event" value={eventSlug} />
      <Field id="invite-name" label="Name" help="How the judge appears to you. Optional." error={e.name}>
        {(a) => <Input {...a} name="name" maxLength={80} />}
      </Field>
      <Field id="invite-email" label="Email" help="Only this address can use the link. Leave empty for a link anyone can use once." error={e.email}>
        {(a) => <Input {...a} name="email" type="email" inputMode="email" />}
      </Field>
      <fieldset
        className="flex flex-col gap-2"
        aria-describedby={e.trackIds ? "invite-tracks-error" : undefined}
      >
        <legend className="text-14 font-medium">Tracks they judge</legend>
        <TrackBoxes tracks={tracks} name="trackIds" />
        <FieldError id="invite-tracks-error" message={e.trackIds} />
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

/**
 * Many judges at once: one per line, "Name <email>" as an email client writes it, "name, email" (a column pasted from a
 * spreadsheet works too) or an address alone, with the tracks ticked for every line that names none of its own. One link each, shown once, as a list to copy.
 */
export function BatchInviteForm({ eventSlug, tracks }: { eventSlug: string; tracks: Track[] }) {
  const [state, form, pending] = useFormAction<BatchInviteResult>(inviteJudgesAction, { ok: false, message: null });
  const errors = state.fieldErrors?.lines ?? [];
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const links = (state.ok ? (state.links ?? []) : []).map((l) => ({ ...l, url: `${origin}${l.path}` }));
  const all = links.map((l) => [l.name, l.email ?? "", l.url].filter(Boolean).join(", ")).join("\n");
  return (
    <form {...form} className="flex flex-col gap-4 pt-3" noValidate>
      <input type="hidden" name="event" value={eventSlug} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-lines" className="text-14 font-medium">
          Judges, one per line
        </label>
        <Textarea
          id="invite-lines"
          name="lines"
          rows={6}
          aria-invalid={errors.length > 0}
          aria-describedby="invite-lines-help"
          placeholder={"Alex Chen <alex@example.org>\nMira Ek, mira@example.org\nJon Berg <jon@example.org>, Security; Health"}
          className="font-mono text-13"
        />
        <p id="invite-lines-help" className="text-13 text-ink-2">
          Paste them as your email or address book gives them: Name &lt;email&gt;, a name and an email separated by a comma or a tab, or an email
          alone. A line without an address makes a link anyone can use once. After the address, a line can name its own tracks, separated by
          semicolons; the other lines take the tracks ticked below.
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-14 font-medium">Tracks, for every line that names none</legend>
        <TrackBoxes tracks={tracks} name="trackIds" />
      </fieldset>
      <div className="flex items-center gap-3">
        <Button disabled={pending}>{pending ? "Making the links…" : "Make the links"}</Button>
      </div>
      {errors.length ? (
        <ul role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-13 text-flag">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {state.message ? (
        <p role="status" className={`text-13 ${state.ok ? "text-ink-2" : "text-flag"}`}>
          {state.message}
        </p>
      ) : null}
      {links.length ? (
        <div className="flex flex-col gap-2 rounded-sm border border-rule bg-sunken p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-13 font-medium">{links.length === 1 ? "One link" : `${links.length} links`}</p>
            <CopyButton text={all} label="Copy all" />
          </div>
          <ul className="flex flex-col divide-y divide-rule">
            {links.map((l) => (
              <li key={l.path} className="flex flex-col gap-1.5 py-2">
                <span className="text-13 wrap-anywhere">
                  <span className="font-medium">{l.name || l.email || "Open link"}</span>
                  {l.name && l.email ? <span className="text-ink-2"> · {l.email}</span> : null}
                </span>
                <span className="font-mono text-12 break-all">{l.url}</span>
                <CopyButton text={l.url} label="Copy link" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}

/** An open invitation's Revoke button; a refusal (accepted meanwhile, no longer your event) shows under it. */
export function RevokeInviteForm({ eventSlug, inviteId }: { eventSlug: string; inviteId: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(revokeInviteAction, { ok: false, message: null }, { resetOnSuccess: false });
  return (
    <form {...form} className="flex max-w-48 shrink-0 flex-col items-end gap-1">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="invite" value={inviteId} />
      <Button size="sm" variant="ghost" disabled={pending}>
        Revoke
      </Button>
      {!state.ok && state.message ? (
        <p role="alert" className="text-right text-12 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

export function TracksForm({ eventSlug, judgeId, tracks, checked }: { eventSlug: string; judgeId: string; tracks: Track[]; checked: string[] }) {
  const [state, form, pending] = useFormAction<ActionResult>(setTracksAction, { ok: false, message: null });
  return (
    <form {...form} className="flex flex-col gap-3 pt-3">
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
  const [state, form, pending] = useFormAction<RunResult>(runAssignmentAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-4">
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
  const [state, form, pending] = useFormAction<ActionResult>(assignByHandAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-3 pt-3">
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
            {j.inTrack ? "" : " (another track: adds this track to theirs)"}
          </option>
        ))}
      </select>
      <label className="text-14 font-medium" htmlFor={`reason-${projectId}`}>
        Reason, for the audit log
      </label>
      <Textarea
        id={`reason-${projectId}`}
        name="reason"
        rows={2}
        aria-invalid={e.reason ? true : undefined}
        aria-describedby={e.reason ? `reason-${projectId}-error` : undefined}
      />
      <FieldError id={`reason-${projectId}-error`} message={e.reason} />
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending}>
          Assign by hand
        </Button>
        {state.message ? <span className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>{state.message}</span> : null}
      </div>
    </form>
  );
}
