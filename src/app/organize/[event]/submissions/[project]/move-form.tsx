"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/server/dal";
import { moveTrackAction } from "./actions";

/** Move a project to another track: the track, the reason, one button. The page above says what happens to its reviews. */
export function MoveTrackForm({
  eventSlug,
  projectId,
  current,
  tracks,
}: {
  eventSlug: string;
  projectId: string;
  current: string;
  tracks: { id: string; name: string }[];
}) {
  const [state, form, pending] = useFormAction<ActionResult>(moveTrackAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="project" value={projectId} />
      <label className="text-14 font-medium" htmlFor="move-track">
        Move to
      </label>
      <select
        id="move-track"
        name="trackId"
        defaultValue=""
        aria-invalid={Boolean(e.trackId)}
        className="h-10 rounded-sm border border-edge bg-surface px-3 text-15 aria-[invalid=true]:border-flag-bar"
      >
        <option value="" disabled>
          Choose a track
        </option>
        {tracks
          .filter((t) => t.id !== current)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
      </select>
      {e.trackId ? <p className="text-13 text-flag">{e.trackId[0]}</p> : null}
      <label className="text-14 font-medium" htmlFor="move-reason">
        Reason, for the audit log
      </label>
      <Textarea id="move-reason" name="reason" rows={2} aria-invalid={Boolean(e.reason)} />
      {e.reason ? <p className="text-13 text-flag">{e.reason[0]}</p> : null}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending}>
          {pending ? "Moving…" : "Move the project"}
        </Button>
      </div>
      {state.message ? (
        <p role="status" className={`text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
