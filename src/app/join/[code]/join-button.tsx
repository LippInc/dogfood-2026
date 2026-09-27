"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { joinTeamAction } from "./actions";

export function JoinButton({ code, teamName }: { code: string; teamName: string }) {
  const [state, action, pending] = useFormAction<ActionResult>(joinTeamAction, { ok: false, message: null });
  return (
    <form {...action} className="flex flex-col gap-3">
      <input type="hidden" name="code" value={code} />
      <Button size="xl" disabled={pending} className="self-start">
        {pending ? "Joining…" : `Join ${teamName}`}
      </Button>
      {state.message ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
