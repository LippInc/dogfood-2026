"use client";

import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import { CopyButton } from "../judges/forms";
import { restoreAction, votersAction, votingLinkAction, votingSettingsAction, voidAction, type LinkResult, type ListResult } from "./actions";

const idle: ActionResult = { ok: false, message: null };

function Status({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
      {state.message}
    </p>
  );
}

const MODES: { value: "account" | "listed" | "link"; label: string; help: string }[] = [
  { value: "account", label: "Signed-in accounts", help: "Anyone with an account on this portal, one ballot each." },
  { value: "listed", label: "People on a voter list", help: "Each address gets a personal link; only those links vote." },
  { value: "link", label: "Anyone with the open link", help: "One ballot per browser; suspected duplicates are flagged for you." },
];

export function VotingSettingsForm({
  eventSlug,
  openAt,
  closeAt,
  modes,
  votesPerVoter,
}: {
  eventSlug: string;
  openAt: string;
  closeAt: string;
  modes: string[];
  votesPerVoter: number;
}) {
  const [state, form, pending] = useFormAction(votingSettingsAction, idle);
  // a close time already passed ends the vote the moment it is saved, and the count is then final
  const [pastClose, setPastClose] = useState(false);
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} onReset={() => setPastClose(false)} className="flex flex-col gap-4">
      <input type="hidden" name="event" value={eventSlug} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="votingOpenAt" label="Voting opens (UTC)" error={e.votingOpenAt}>
          {(a) => <Input {...a} name="votingOpenAt" type="datetime-local" defaultValue={openAt} />}
        </Field>
        <Field id="votingCloseAt" label="Voting closes (UTC)" error={e.votingCloseAt}>
          {(a) => (
            <Input
              {...a}
              name="votingCloseAt"
              type="datetime-local"
              defaultValue={closeAt}
              onChange={(ev) => setPastClose(ev.currentTarget.value !== "" && Date.parse(`${ev.currentTarget.value.slice(0, 16)}:00Z`) <= Date.now())}
            />
          )}
        </Field>
      </div>
      {pastClose ? (
        <p role="status" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          That close time has passed: saving ends the vote now, and the count becomes public and final.
        </p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-14 font-medium">Who may vote</legend>
        {MODES.map((m) => (
          <label key={m.value} className="flex items-start gap-2 text-14">
            <input type="checkbox" name="modes" value={m.value} defaultChecked={modes.includes(m.value)} className="mt-0.5 size-4 accent-[var(--primary)]" />
            <span>
              <span className="font-medium">{m.label}</span> <span className="text-ink-2">· {m.help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <Field id="votesPerVoter" label="Favourites per voter" error={e.votesPerVoter}>
        {(a) => <Input {...a} name="votesPerVoter" type="number" min={1} max={20} defaultValue={votesPerVoter} className="w-28" />}
      </Field>
      <div className="flex items-center gap-3">
        <Button disabled={pending}>Save voting settings</Button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function VotingLinkForm({ eventSlug, active }: { eventSlug: string; active: boolean }) {
  const [state, form, pending] = useFormAction<LinkResult>(votingLinkAction, idle);
  const link = state.path && typeof window !== "undefined" ? `${window.location.origin}${state.path}` : state.path;
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="event" value={eventSlug} />
      <p className="text-14 text-ink-2">{active ? "An open link exists. Making a new one stops the old one." : "No open link yet."}</p>
      <div>
        <Button variant="outline" disabled={pending}>
          {active ? "Replace the open link" : "Make the open link"}
        </Button>
      </div>
      {state.ok && link ? (
        <div className="flex flex-col gap-2 rounded-sm border border-rule bg-sunken p-3">
          <p className="font-mono text-12 break-all">{link}</p>
          <CopyButton text={link} label="Copy link" />
        </div>
      ) : null}
      <Status state={state} />
    </form>
  );
}

export function VoterListForm({ eventSlug }: { eventSlug: string }) {
  const [state, form, pending] = useFormAction<ListResult>(votersAction, idle);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const text = (state.links ?? []).map((l) => `${l.email},${origin}${l.path}`).join("\n");
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="event" value={eventSlug} />
      <label htmlFor="emails" className="text-14 font-medium">
        Email addresses, one per line or separated by commas
      </label>
      <Textarea id="emails" name="emails" rows={4} aria-invalid={Boolean(state.fieldErrors?.emails)} />
      {state.fieldErrors?.emails ? <p className="text-13 text-flag">{state.fieldErrors.emails[0]}</p> : null}
      <div>
        <Button variant="outline" disabled={pending}>
          Make personal links
        </Button>
      </div>
      <Status state={state} />
      {state.links?.length ? (
        <div className="flex flex-col gap-2 rounded-sm border border-rule bg-sunken p-3">
          <pre className="max-h-48 overflow-auto font-mono text-12 whitespace-pre-wrap">{text}</pre>
          <CopyButton text={text} label="Copy all as CSV" />
        </div>
      ) : null}
    </form>
  );
}

export function VoidForm({ eventSlug, voterId, voided }: { eventSlug: string; voterId: string; voided: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, form, pending] = useFormAction(voided ? restoreAction : voidAction, idle);
  if (voided) {
    return (
      <form {...form} className="flex items-center gap-2">
        <input type="hidden" name="event" value={eventSlug} />
        <input type="hidden" name="voter" value={voterId} />
        <Button size="sm" variant="ghost" disabled={pending}>
          Restore
        </Button>
        <Status state={state} />
      </form>
    );
  }
  if (!open) {
    return (
      <Button size="sm" variant="outline" type="button" onClick={() => setOpen(true)}>
        Set aside…
      </Button>
    );
  }
  return (
    <form {...form} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="voter" value={voterId} />
      <Input
        name="reason"
        placeholder="Reason, for the audit log"
        className="w-64"
        aria-label="Reason"
        aria-invalid={state.fieldErrors?.reason ? true : undefined}
        autoFocus
      />
      <Button size="sm" disabled={pending}>
        Set aside
      </Button>
      {state.fieldErrors?.reason ? <p className="text-13 text-flag">{state.fieldErrors.reason[0]}</p> : <Status state={state} />}
    </form>
  );
}
