"use client";

import { createContext, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useFormAction } from "@/components/use-form-action";
import type { ActionResult } from "@/server/dal";

/**
 * One titled settings section with its own save button and result line. Field
 * errors come back keyed by field name and are listed under the heading. The form
 * keeps what was typed (useFormAction), unless resetOnSuccess clears it after a
 * successful save (an "add" form). `before` renders between the heading and the
 * form, outside it: the place for content with forms of its own, since a form
 * inside a form is dropped by the HTML parser and its buttons submit the outer one.
 *
 * Optional `fieldLabels` (field name to its visible label) turns on plain-words errors:
 * each error is listed under the field's label instead of its key, the refused fields are
 * marked aria-invalid and the first one takes focus, and a rows editor inside marks its
 * refused rows (a key that is a number is a row, named `rowLabel` and its place). Without
 * it the section behaves as before.
 */
export const SectionErrors = createContext<Record<string, string[] | undefined> | null>(null);
export function SectionForm({
  id,
  title,
  description,
  action,
  hidden,
  submitLabel = "Save",
  resetOnSuccess = false,
  before,
  fieldLabels,
  rowLabel = "Row",
  number,
  children,
}: {
  id: string;
  title: string;
  description?: React.ReactNode;
  action: (prev: ActionResult, form: FormData) => Promise<ActionResult>;
  hidden?: Record<string, string>;
  submitLabel?: string;
  resetOnSuccess?: boolean;
  before?: React.ReactNode;
  fieldLabels?: Record<string, string>;
  rowLabel?: string;
  /** Optional: the section's place on a long page ("01"), shown before the title and hidden from screen readers. */
  number?: string;
  children: React.ReactNode;
}) {
  const [state, form, pending] = useFormAction<ActionResult>(action, { ok: false, message: null }, { resetOnSuccess });
  const named = (k: string) =>
    !fieldLabels ? `${k}: ` : fieldLabels[k] ? `${fieldLabels[k]}: ` : /^\d+$/.test(k) ? `${rowLabel} ${Number(k) + 1}: ` : k === "request" ? "" : `${k}: `;
  const errors = Object.entries(state.fieldErrors ?? {}).flatMap(([k, v]) => v.map((m) => `${named(k)}${m}`));
  const formEl = form.ref;
  useEffect(() => {
    // with fieldLabels: mark the refused fields and move focus to the first, so "check the highlighted fields" is true
    const el = formEl.current;
    if (!fieldLabels || !el) return;
    const bad = new Set(Object.keys(state.fieldErrors ?? {}));
    let first: HTMLElement | null = null;
    for (const c of Array.from(el.elements) as HTMLInputElement[]) {
      if (!c.name || c.type === "hidden") continue;
      if (bad.has(c.name)) {
        c.setAttribute("aria-invalid", "true");
        first ??= c;
      } else c.removeAttribute("aria-invalid");
    }
    first?.focus();
  }, [state, fieldLabels, formEl]);
  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-5 rounded-sm border border-rule bg-surface p-5 lg:p-6">
      <div>
        <h2 id={`${id}-title`} className="text-17 font-semibold">
          {number ? (
            <span aria-hidden className="mr-2.5 font-mono text-13 font-normal text-ink-3">
              {number}
            </span>
          ) : null}
          {title}
        </h2>
        {description ? <div className="mt-1 max-w-[720px] text-14 text-ink-2">{description}</div> : null}
      </div>
      {before ? <div>{before}</div> : null}
      <form {...form} className="flex flex-col gap-5" noValidate>
        {hidden ? Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />) : null}
        {fieldLabels ? <SectionErrors.Provider value={state.fieldErrors ?? null}>{children}</SectionErrors.Provider> : children}
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
