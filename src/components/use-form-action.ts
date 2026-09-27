"use client";

import { startTransition, useActionState, useEffect, useRef } from "react";

/**
 * useActionState for a form that keeps what was typed when its action refuses.
 * React resets a form after every action it runs from the action prop; this hook
 * sends the form from onSubmit instead and resets it only after a success, so a
 * refused sign-up, comment or vote setting keeps its fields while a posted one
 * clears as before. Forms that show saved values (settings, the project form) pass
 * resetOnSuccess: false and never reset. The action prop stays, so the form also
 * works before hydration. Spread the second value onto the form: <form {...form}>.
 */
export function useFormAction<S>(
  action: (prev: Awaited<S>, form: FormData) => Promise<S>,
  initial: Awaited<S>,
  { resetOnSuccess = true }: { resetOnSuccess?: boolean } = {},
) {
  const [state, formAction, pending] = useActionState<S, FormData>(action, initial);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && (state as { ok?: boolean }).ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  const form = {
    ref,
    action: formAction,
    onSubmit(e: React.FormEvent<HTMLFormElement>) {
      e.preventDefault();
      const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
      startTransition(() => formAction(data));
    },
  };
  return [state, form, pending] as const;
}
