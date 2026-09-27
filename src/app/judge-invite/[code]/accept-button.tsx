"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { acceptInviteAction } from "./actions";

export function AcceptButton({ code }: { code: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(acceptInviteAction, { ok: false, message: null });
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="code" value={code} />
      <Button size="xl" disabled={pending} className="self-start">
        {pending ? "Joining…" : "Accept and open the judging console"}
      </Button>
      {state.message ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
