"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatUtc } from "@/lib/format";
import { CopyButton } from "../[event]/judges/forms";
import { resetLinkAction, type ResetLinkResult } from "./actions";

const idle: ResetLinkResult = { ok: false, message: null };

export function ResetLinkForm() {
  const [state, form, pending] = useFormAction<ResetLinkResult>(resetLinkAction, idle);
  const link = state.path && typeof window !== "undefined" ? `${window.location.origin}${state.path}` : state.path;
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex max-w-[560px] flex-col gap-4">
      <Field id="reset-email" label="The account's email address" error={e.email}>
        {(a) => <Input {...a} name="email" type="email" required autoComplete="off" />}
      </Field>
      <div>
        <Button disabled={pending}>{pending ? "Making the link…" : "Make a reset link"}</Button>
      </div>
      {state.message && !state.ok ? (
        <p role="status" className="text-14 text-flag">
          {state.message}
        </p>
      ) : null}
      {state.ok && link ? (
        <div role="status" className="flex flex-col gap-2 rounded-sm border border-rule bg-sunken p-3">
          <p className="text-14">
            For <strong className="font-semibold">{state.name}</strong> <span className="text-ink-2">({state.email})</span>. Shown only now; it works once,
            until {formatUtc(state.expiresAt ?? null)}.
          </p>
          <p className="font-mono text-12 break-all">{link}</p>
          <CopyButton text={link} label="Copy link" />
        </div>
      ) : null}
    </form>
  );
}
