"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { importEventAction, type ImportResult } from "./actions";

const idle: ImportResult = { ok: false, message: null };

/**
 * The file picker and its button on one line inside a dashed slip (the place a file goes), and
 * the import's report under them: ruled green when it went in, orange when it was refused.
 */
export function ImportEventForm() {
  const [state, form, pending] = useFormAction(importEventAction, idle);
  return (
    <form {...form} className="flex max-w-[680px] flex-col gap-3 rounded-sm border border-dashed border-edge bg-surface p-4 sm:p-5">
      <label htmlFor="event-file" className="text-14 font-medium">
        Event file (JSON, the fixture format)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id="event-file"
          name="file"
          type="file"
          accept="application/json,.json"
          required
          className="min-w-0 flex-1 text-14 text-ink-2 file:mr-3 file:h-8 file:rounded-sm file:border file:border-edge file:bg-raised file:px-3 file:text-14 file:font-medium file:text-ink"
        />
        <Button disabled={pending}>{pending ? "Importing…" : "Import"}</Button>
      </div>
      {state.message ? (
        <p
          role="status"
          className={`border-l-[3px] px-3 py-2 text-14 ${state.ok ? "border-ok text-ink" : "border-flag-bar bg-flag-bg text-flag"}`}
        >
          {state.message}{" "}
          {state.ok && state.slug ? (
            <Link href={`/organize/${state.slug}`} className="inline-flex items-center gap-1 font-medium whitespace-nowrap underline underline-offset-4">
              Open the event
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
