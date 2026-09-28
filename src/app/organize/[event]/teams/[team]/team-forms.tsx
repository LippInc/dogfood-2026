"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import { organizerRenameAction } from "./actions";

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
