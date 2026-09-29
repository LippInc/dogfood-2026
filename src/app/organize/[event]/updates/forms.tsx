"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useFormAction } from "@/components/use-form-action";
import type { ActionResult } from "@/server/dal";
import { editUpdateAction, removeUpdateAction } from "./actions";

const field = "w-full rounded-sm border border-edge bg-surface px-2.5 text-14";
export const TITLE_INPUT = `h-8 ${field}`;
export const BODY_INPUT = `${field} py-2 font-serif text-15 leading-6`;

/** An update's edit form, opened under it; saving keeps the old words in the audit log and mails nothing. */
export function EditUpdate({ eventSlug, id, title, body, titleMax, bodyMax }: { eventSlug: string; id: string; title: string; body: string; titleMax: number; bodyMax: number }) {
  const [state, form, pending] = useFormAction<ActionResult>(editUpdateAction, { ok: false, message: null }, { resetOnSuccess: false });
  const errors = Object.values(state.fieldErrors ?? {}).flat();
  return (
    <details className="group mt-3">
      <summary className="inline-flex cursor-pointer list-none items-center rounded-sm text-13 font-medium text-ink underline underline-offset-2 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Edit</span>
        <span className="hidden group-open:inline">Close the editor</span>
        <span className="sr-only"> the update {title}</span>
      </summary>
      <form {...form} className="mt-3 flex max-w-[680px] flex-col gap-3" noValidate>
        <input type="hidden" name="event" value={eventSlug} />
        <input type="hidden" name="update" value={id} />
        <label className="flex flex-col gap-1 text-13 text-ink-2">
          Title
          <input name="title" defaultValue={title} maxLength={titleMax} className={TITLE_INPUT} />
        </label>
        <label className="flex flex-col gap-1 text-13 text-ink-2">
          The update (plain text; line breaks are kept)
          <textarea name="body" defaultValue={body} rows={5} maxLength={bodyMax} className={BODY_INPUT} />
        </label>
        {errors.length ? (
          <ul role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-13 text-flag">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save the change"}
          </Button>
          <p role="status" aria-live="polite" className={state.ok ? "text-13 text-ok" : "text-13 text-flag"}>
            {errors.length ? "" : (state.message ?? "")}
          </p>
        </div>
        <p className="text-12 text-ink-3">Nothing is mailed again. The page shows the update as edited; the audit log keeps its old words.</p>
      </form>
    </details>
  );
}

/** Remove, in two steps: the first click asks, the second removes. */
export function RemoveUpdate({ eventSlug, id, title }: { eventSlug: string; id: string; title: string }) {
  const [asking, setAsking] = useState(false);
  const [state, form, pending] = useFormAction<ActionResult>(removeUpdateAction, { ok: false, message: null });
  if (!asking)
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setAsking(true)} aria-label={`Remove the update ${title}`}>
        Remove…
      </Button>
    );
  return (
    <form {...form} className="flex flex-wrap items-center justify-end gap-2">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="update" value={id} />
      <span className="text-13 text-ink-2">Take it off the event&apos;s pages?</span>
      <Button size="sm" disabled={pending} autoFocus>
        {pending ? "Removing…" : "Remove"}
      </Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setAsking(false)}>
        Keep it
      </Button>
      {state.message && !state.ok ? (
        <p role="alert" className="w-full text-right text-13 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
