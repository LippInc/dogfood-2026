"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { enterAction } from "./actions";

export function EnterButton({ code }: { code: string }) {
  const [state, action, pending] = useFormAction<ActionResult>(enterAction, { ok: false, message: null });
  return (
    <form {...action} className="flex flex-col gap-3">
      <input type="hidden" name="code" value={code} />
      <Button size="xl" disabled={pending} className="self-start">
        {pending ? "Opening…" : "Open my ballot"}
      </Button>
      {state.message ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
