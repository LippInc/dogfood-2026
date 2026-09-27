"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/dal";
import { resetAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

export function ResetForm({ token }: { token: string }) {
  const [state, form, pending] = useFormAction(resetAction.bind(null, token), idle);
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex max-w-[420px] flex-col gap-4">
      <Field id="reset-password" label="New password" help="At least 10 characters." error={e.password}>
        {(a) => <Input {...a} name="password" type="password" required minLength={10} autoComplete="new-password" />}
      </Field>
      <div>
        <Button disabled={pending}>{pending ? "Saving…" : "Set the new password and sign in"}</Button>
      </div>
      {state.message && !state.ok ? (
        <p role="status" className="text-14 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
