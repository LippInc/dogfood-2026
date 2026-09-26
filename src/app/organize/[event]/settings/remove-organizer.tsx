"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { removeOrganizerAction } from "./actions";

/** One organizer's Remove button; the server keeps the last organizer (409). */
export function RemoveOrganizer({ eventSlug, userId, name }: { eventSlug: string; userId: string; name: string }) {
  const [state, run, pending] = useActionState<ActionResult, FormData>(removeOrganizerAction, { ok: false, message: null });
  return (
    <form action={run} className="flex flex-col items-end gap-1">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="user" value={userId} />
      <Button variant="outline" size="sm" disabled={pending} aria-label={`Remove ${name} as an organizer`}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      {state.message && !state.ok ? (
        <p role="alert" className="text-13 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
