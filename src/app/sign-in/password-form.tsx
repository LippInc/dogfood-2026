"use client";

import { useFormAction } from "@/components/use-form-action";
import { passwordSignIn, type SignInState } from "./actions";

export function PasswordForm({ next }: { next: string | null }) {
  const [state, form, pending] = useFormAction<SignInState>(passwordSignIn, { message: null });
  return (
    <form {...form} className="flex flex-col gap-4" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <label className="flex flex-col gap-1.5 text-14 font-medium">
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="h-11 rounded-sm border border-edge bg-surface px-3 text-15 font-normal"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-14 font-medium">
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-11 rounded-sm border border-edge bg-surface px-3 text-15 font-normal"
        />
      </label>
      {state.message ? (
        <p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
          {state.message}
        </p>
      ) : null}
      <button
        disabled={pending}
        className="h-11 rounded-sm bg-primary px-4 text-15 font-semibold text-on-primary disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
