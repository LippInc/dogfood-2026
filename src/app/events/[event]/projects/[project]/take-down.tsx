"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFormAction } from "@/components/use-form-action";
import type { ActionResult } from "@/server/dal";
import { takeDownPictureAction } from "./actions";

/** Under the picture, for this event's organizers only: take it down, with a reason for the audit log. */
export function TakeDownPicture({ projectId, path }: { projectId: string; path: string }) {
  const [open, setOpen] = useState(false);
  const [state, form, pending] = useFormAction<ActionResult>(takeDownPictureAction, { ok: false, message: null });
  if (!open)
    return (
      <Button type="button" variant="ghost" size="sm" className="-ml-2.5 self-start text-13" onClick={() => setOpen(true)}>
        Take this picture down
      </Button>
    );
  return (
    <form {...form} className="flex flex-col gap-2 border-l-[3px] border-flag-bar pl-3">
      <input type="hidden" name="project" value={projectId} />
      <input type="hidden" name="path" value={path} />
      <label htmlFor="take-down-reason" className="text-13 font-medium">
        Why it comes down (goes into the audit log)
      </label>
      <div className="flex flex-wrap gap-2">
        <Input id="take-down-reason" name="reason" required minLength={3} maxLength={300} className="h-9 min-w-0 flex-1 text-14" />
        <Button size="sm" variant="outline" disabled={pending} className="h-9">
          Take it down
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-9" onClick={() => setOpen(false)}>
          Keep it
        </Button>
      </div>
      {state.message ? (
        <p aria-live="polite" className={`text-13 ${state.ok ? "text-ink-2" : "font-medium text-flag"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
