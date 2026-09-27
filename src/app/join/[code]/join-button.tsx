"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { joinTeamAction } from "./actions";

export function JoinButton({ code, teamName }: { code: string; teamName: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(joinTeamAction, { ok: false, message: null });
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="code" value={code} />
      <Button size="xl" disabled={pending} className="max-w-full self-start">
        <span className="truncate">{pending ? "Joining…" : `Join ${teamName}`}</span>
      </Button>
      {state.message ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
