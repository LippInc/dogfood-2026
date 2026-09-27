"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { passwordSignIn, type SignInState } from "./actions";

/** Email and password, built from the same Field, Input and Button as the sign-up form. */
export function PasswordForm({ next }: { next: string | null }) {
  const [state, form, pending] = useFormAction<SignInState>(passwordSignIn, { message: null });
  return (
    <form {...form} className="flex flex-col gap-5" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Field id="email" label="Email">
        {(a) => <Input {...a} name="email" type="email" autoComplete="email" required className="max-sm:h-11" />}
      </Field>
      <Field id="password" label="Password">
        {(a) => <Input {...a} name="password" type="password" autoComplete="current-password" required className="max-sm:h-11" />}
      </Field>
      {state.message ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
      <Button size="xl" disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
