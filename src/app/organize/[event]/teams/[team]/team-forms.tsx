"use client";

import { useRef, useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { useRescueFocus } from "@/components/use-rescue-focus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import { organizerAddAction, organizerRemoveAction, organizerRenameAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

function Result({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  const detail = state.ok ? null : (state.fieldErrors?.name?.[0] ?? state.fieldErrors?.reason?.[0] ?? state.fieldErrors?.email?.[0]);
  return (
    <p role="status" className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
      {state.message}
      {detail ? ` ${detail}` : ""}
    </p>
  );
}

/** Rename the team as an organizer: the new name and why, for the audit log. */
export function RenameTeamForm({ teamId, eventSlug, name }: { teamId: string; eventSlug: string; name: string }) {
  const [state, form, pending] = useFormAction(organizerRenameAction, idle);
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="team" value={teamId} />
      <input type="hidden" name="event" value={eventSlug} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rename-name" className="text-14 font-medium">
          Team name
        </label>
        <Input id="rename-name" name="name" defaultValue={name} maxLength={60} aria-invalid={state.fieldErrors?.name ? true : undefined} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="rename-reason" className="text-14 font-medium">
          Reason, for the audit log
        </label>
        <Textarea id="rename-reason" name="reason" rows={2} maxLength={300} aria-invalid={state.fieldErrors?.reason ? true : undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={pending}>
          {pending ? "Renaming…" : "Rename the team"}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

/** Put someone with an account on the team: their address and why. */
export function AddMemberForm({ teamId, eventSlug }: { teamId: string; eventSlug: string }) {
  const [state, form, pending] = useFormAction(organizerAddAction, idle);
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="team" value={teamId} />
      <input type="hidden" name="event" value={eventSlug} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="add-email" className="text-14 font-medium">
          Their account&apos;s email
        </label>
        <Input id="add-email" name="email" type="email" autoComplete="off" aria-invalid={state.fieldErrors?.email ? true : undefined} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="add-reason" className="text-14 font-medium">
          Reason, for the audit log
        </label>
        <Textarea id="add-reason" name="reason" rows={2} maxLength={300} aria-invalid={state.fieldErrors?.reason ? true : undefined} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" disabled={pending}>
          {pending ? "Adding…" : "Add to the team"}
        </Button>
        <Result state={state} />
      </div>
    </form>
  );
}

/** Take one member off: the button opens a reason box in the row. */
export function RemoveMemberForm({ teamId, eventSlug, userId, name }: { teamId: string; eventSlug: string; userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [state, form, pending] = useFormAction(organizerRemoveAction, idle);
  // Cancel removes the box: focus goes back to the button that opened it.
  const opener = useRef<HTMLButtonElement>(null);
  useRescueFocus(() => opener.current, open);
  if (!open) {
    return (
      <Button ref={opener} type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} className="-ml-2.5 h-7 text-13 md:ml-0">
        Take off…
      </Button>
    );
  }
  return (
    <form {...form} className="flex w-full min-w-[240px] flex-col gap-2 py-1">
      <input type="hidden" name="team" value={teamId} />
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="user" value={userId} />
      <label htmlFor={`remove-reason-${userId}`} className="text-13 font-medium">
        Why {name} leaves the team
      </label>
      <Textarea id={`remove-reason-${userId}`} name="reason" rows={2} maxLength={300} autoFocus aria-invalid={state.fieldErrors?.reason ? true : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" disabled={pending} className="text-flag">
          {pending ? "Taking off…" : "Take off the team"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <Result state={state} />
    </form>
  );
}
