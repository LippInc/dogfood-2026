"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field, FormFailure } from "@/components/field";
import { KeptNotice } from "@/components/kept-notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/server/dal";
import { signUpAction } from "./actions";

export function SignUpForm({ next, setup }: { next: string | null; setup: string | null }) {
  const [state, form, pending] = useFormAction<ActionResult>(signUpAction, { ok: false, message: null });
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-5" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {setup ? <input type="hidden" name="setup" value={setup} /> : null}
      {setup ? (
        <p className="border-l-[3px] border-edge bg-sunken px-3 py-2 text-14">
          Administrator setup: sign up with the address named in <code className="font-mono text-13">ADMIN_EMAILS</code> to administer this portal.
        </p>
      ) : null}
      <Field id="name" label="Your name" error={e.name}>
        {(a) => <Input {...a} name="name" autoComplete="name" required className="max-sm:h-11" />}
      </Field>
      <Field id="email" label="Email" error={e.email}>
        {(a) => <Input {...a} name="email" type="email" autoComplete="email" required className="max-sm:h-11" />}
      </Field>
      <Field id="password" label="Password" help="At least 10 characters." error={e.password}>
        {(a) => <Input {...a} name="password" type="password" autoComplete="new-password" required className="max-sm:h-11" />}
      </Field>
      <FormFailure message={state.ok ? null : state.message} />
      <Button size="xl" disabled={pending}>
        {pending ? "Creating the account…" : "Create account"}
      </Button>
      <KeptNotice>We keep your name, your email address and a one-way hash of your password; your name shows beside what you write here.</KeptNotice>
    </form>
  );
}
