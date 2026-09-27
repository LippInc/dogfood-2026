"use client";

import Link from "next/link";
import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { importEventAction, type ImportResult } from "./actions";

const idle: ImportResult = { ok: false, message: null };

export function ImportEventForm() {
  const [state, action, pending] = useFormAction(importEventAction, idle);
  return (
    <form {...action} className="flex flex-col gap-3">
      <label htmlFor="event-file" className="text-14 font-medium">
        Event file (JSON, the fixture format)
      </label>
      <input
        id="event-file"
        name="file"
        type="file"
        accept="application/json,.json"
        required
        className="text-14 file:mr-3 file:h-9 file:rounded-sm file:border file:border-edge file:bg-surface file:px-3 file:text-14 file:font-medium"
      />
      <div>
        <Button disabled={pending}>{pending ? "Importing…" : "Import"}</Button>
      </div>
      {state.message ? (
        <p role="status" className={`text-14 ${state.ok ? "" : "text-flag"}`}>
          {state.message}{" "}
          {state.ok && state.slug ? (
            <Link href={`/organize/${state.slug}`} className="underline underline-offset-4">
              Open the event
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
