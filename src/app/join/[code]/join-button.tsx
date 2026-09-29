"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { joinTeamAction } from "./actions";
import { FormFailure } from "@/components/field";

export function JoinButton({ code, teamName }: { code: string; teamName: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(joinTeamAction, { ok: false, message: null });
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="code" value={code} />
      <Button size="xl" disabled={pending} className="max-w-full self-start">
        <span className="truncate">{pending ? "Joining…" : `Join ${teamName}`}</span>
      </Button>
      <FormFailure message={state.message} />
    </form>
  );
}
