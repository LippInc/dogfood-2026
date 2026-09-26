"use client";

import { useActionState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/dal";
import { signUpAction } from "./actions";

export function SignUpForm({ next }: { next: string | null }) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(signUpAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field id="name" label="Your name" error={e.name}>
        {(a) => <Input {...a} name="name" autoComplete="name" required />}
      </Field>
      <Field id="email" label="Email" error={e.email}>
        {(a) => <Input {...a} name="email" type="email" autoComplete="email" required />}
      </Field>
      <Field id="password" label="Password" help="At least 10 characters." error={e.password}>
        {(a) => <Input {...a} name="password" type="password" autoComplete="new-password" required />}
      </Field>
      {state.message && !state.ok ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
      <Button size="xl" disabled={pending}>
        {pending ? "Creating the account…" : "Create account"}
      </Button>
    </form>
  );
}
