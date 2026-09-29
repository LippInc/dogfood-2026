"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field, FormFailure } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/dal";
import { claimAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

export function ClaimForm({ token, name, eventName }: { token: string; name: string; eventName: string }) {
  const [state, form, pending] = useFormAction(claimAction.bind(null, token), idle);
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-4">
      <Field id="claim-name" label="Your name" help="As the organizers imported it. Change it if it is not how you want to be named." error={e.name}>
        {(a) => <Input {...a} name="name" defaultValue={name} autoComplete="name" className="max-sm:h-11" />}
      </Field>
      <Field id="claim-password" label="Choose a password" help="At least 10 characters." error={e.password}>
        {(a) => <Input {...a} name="password" type="password" required minLength={10} autoComplete="new-password" className="max-sm:h-11" />}
      </Field>
      <FormFailure message={state.ok ? null : state.message} />
      <Button size="xl" disabled={pending}>
        {pending ? "Saving…" : "Set my password and sign in"}
      </Button>
      <p className="text-14 text-ink-3">Saving signs you in and opens {eventName}. This link then stops working.</p>
    </form>
  );
}
