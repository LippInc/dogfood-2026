"use client";

import { useActionState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/dal";
import { claimAction } from "./actions";

const idle: ActionResult = { ok: false, message: null };

export function ClaimForm({ token, name }: { token: string; name: string }) {
  const [state, action, pending] = useActionState(claimAction.bind(null, token), idle);
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex max-w-[420px] flex-col gap-4">
      <Field id="claim-name" label="Your name" error={e.name}>
        {(a) => <Input {...a} name="name" defaultValue={name} autoComplete="name" />}
      </Field>
      <Field id="claim-password" label="Choose a password" help="At least 10 characters." error={e.password}>
        {(a) => <Input {...a} name="password" type="password" required minLength={10} autoComplete="new-password" />}
      </Field>
      <div>
        <Button disabled={pending}>{pending ? "Saving…" : "Set my password and sign in"}</Button>
      </div>
      {state.message && !state.ok ? (
        <p role="status" className="text-14 text-flag">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
