"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult, PanelView } from "@/server/dal";
import { saveFinalsScoreAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

type Criterion = PanelView["criteria"][number];

/**
 * One finalist's score: a row of choices per criterion (a native radio group, so Tab moves between criteria and the
 * arrow keys between values, as in any form), and one save. Saving again replaces the panelist's own score.
 */
export function FinalsScoreForm({
  eventSlug,
  finalsId,
  projectId,
  title,
  criteria,
  values,
  readOnly,
}: {
  eventSlug: string;
  finalsId: string;
  projectId: string;
  title: string;
  criteria: Criterion[];
  values: Record<string, number> | null;
  readOnly: boolean;
}) {
  const [state, form, pending] = useFormAction(saveFinalsScoreAction, idle, { resetOnSuccess: false });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-4">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="finals" value={finalsId} />
      <input type="hidden" name="project" value={projectId} />
      {criteria.map((c) => {
        const levels = Array.from({ length: c.scaleMax - c.scaleMin + 1 }, (_, i) => c.scaleMin + i);
        const id = `${finalsId}-${projectId}-${c.key}`;
        const err = e[c.key]?.[0];
        return (
          <fieldset key={c.key} className="flex flex-col gap-2" aria-describedby={err ? `${id}-error` : undefined} disabled={readOnly}>
            <legend className="text-14 font-medium">
              {c.label} <span className="text-12 font-normal text-ink-2 tnum">× {c.weight}</span>
            </legend>
            {c.prompt ? <p className="-mt-1 text-13 text-ink-2">{c.prompt}</p> : null}
            <div className="flex flex-wrap gap-1.5">
              {levels.map((v) => (
                <label key={v} className="relative">
                  <input
                    type="radio"
                    name={`c:${c.key}`}
                    value={v}
                    defaultChecked={values?.[c.key] === v}
                    className="peer absolute inset-0 cursor-pointer opacity-0"
                    aria-label={`${c.label}: ${v}${c.anchors[String(v)] ? `, ${c.anchors[String(v)]}` : ""} (${title})`}
                  />
                  <span className="flex size-10 items-center justify-center rounded-sm border border-edge text-15 tnum peer-checked:border-primary peer-checked:bg-primary peer-checked:text-on-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus,currentColor)] sm:size-9">
                    {v}
                  </span>
                </label>
              ))}
            </div>
            {err ? (
              <p id={`${id}-error`} className="text-13 text-flag">
                {err}
              </p>
            ) : null}
          </fieldset>
        );
      })}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {values ? "Save again" : "Save score"}
          </Button>
          <p role="status" className={`min-h-5 text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
            {state.message ?? ""}
          </p>
        </div>
      )}
    </form>
  );
}
