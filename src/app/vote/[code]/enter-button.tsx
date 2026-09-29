"use client";

import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/server/dal";
import { enterAction } from "./actions";
import { FormFailure } from "@/components/field";

export function EnterButton({ code }: { code: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(enterAction, { ok: false, message: null });
  return (
    <form {...form} className="flex flex-col gap-3">
      <input type="hidden" name="code" value={code} />
      <Button size="xl" disabled={pending} className="self-start">
        {pending ? "Opening…" : "Open my ballot"}
      </Button>
      <FormFailure message={state.message} />
    </form>
  );
}
