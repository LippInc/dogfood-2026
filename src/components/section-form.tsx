"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";

/**
 * One titled settings section with its own save button and result line. Field
 * errors come back keyed by field name and are listed under the heading.
 */
export function SectionForm({
  id,
  title,
  description,
  action,
  hidden,
  submitLabel = "Save",
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  hidden?: Record<string, string>;
  submitLabel?: string;
  children: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(action, { ok: false, message: null });
  const errors = Object.entries(state.fieldErrors ?? {}).flatMap(([k, v]) => v.map((m) => `${k}: ${m}`));
  return (
    <section aria-labelledby={`${id}-title`} className="rounded-sm border border-rule bg-surface">
      <form action={formAction} className="flex flex-col gap-5 p-5 lg:p-6" noValidate>
        {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
        <div>
          <h2 id={`${id}-title`} className="text-17 font-semibold">
            {title}
          </h2>
          {description ? <div className="mt-1 max-w-[720px] text-14 text-ink-2">{description}</div> : null}
        </div>
        {children}
        {errors.length ? (
          <ul role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-13 text-flag">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center gap-3 border-t border-rule pt-4">
          <Button disabled={pending}>{pending ? "Saving…" : submitLabel}</Button>
          <p role="status" aria-live="polite" className={state.ok ? "text-13 text-ok" : "text-13 text-flag"}>
            {state.message ?? ""}
          </p>
        </div>
      </form>
    </section>
  );
}
