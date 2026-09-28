"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "../[event]/judges/forms";
import { resetLinkAction, type ResetLinkResult } from "./actions";

const idle: ResetLinkResult = { ok: false, message: null };

/**
 * The address, one button, and the link it makes, which the action returns drawn as the
 * ticket the person will open (reset-ticket.tsx: faces are drawn on the server).
 */
export function ResetLinkForm() {
  const [state, form, pending] = useFormAction<ResetLinkResult>(resetLinkAction, idle);
  const e = state.fieldErrors ?? {};
  return (
    <>
      <form {...form} className="flex flex-col gap-3 rounded-sm border border-rule bg-surface p-5">
        <Field id="reset-email" label="The account's email address" error={e.email}>
          {(a) => (
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input {...a} name="email" type="email" required autoComplete="off" spellCheck={false} className="sm:flex-1" />
              <Button disabled={pending} className="shrink-0 max-sm:self-start">
                {pending ? "Making the link…" : "Make a reset link"}
              </Button>
            </div>
          )}
        </Field>
        {state.message && !state.ok ? (
          <p role="status" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">
            {state.message}
          </p>
        ) : null}
      </form>
      {state.ok && state.ticket ? <div role="status">{state.ticket}</div> : null}
    </>
  );
}

/** The link in full, with the page's own origin, and a button that copies it. */
export function ResetLinkBox({ path }: { path: string }) {
  const link = typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
  return (
    <div className="flex flex-col gap-3 rounded-xs border border-rule bg-sunken p-3">
      <p className="font-mono text-13 break-all">{link}</p>
      <div>
        <CopyButton text={link} label="Copy link" />
      </div>
    </div>
  );
}
