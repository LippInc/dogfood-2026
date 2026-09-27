"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "../../organize/[event]/judges/forms";
import { formatUtc } from "@/lib/format";
import { createTokenAction, type TokenResult } from "./actions";
import { TokenMark } from "./token-mark";

const idle: TokenResult = { ok: false, message: null };

export function TokenForm() {
  const [state, form, pending] = useFormAction(createTokenAction, idle);
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <Field id="token-name" label="Name" error={e.name}>
          {(a) => <Input {...a} name="name" required maxLength={60} placeholder="Results sync script" className="w-72" />}
        </Field>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="token-days" className="text-14 font-medium">
            Expires
          </label>
          <select id="token-days" name="days" defaultValue="90" className="h-10 rounded-sm border border-edge bg-surface px-3 text-14">
            <option value="30">in 30 days</option>
            <option value="90">in 90 days</option>
            <option value="365">in a year</option>
            <option value="never">never</option>
          </select>
        </div>
        <Button size="lg" disabled={pending}>
          {pending ? "Making…" : "Make a token"}
        </Button>
      </div>
      {state.message ? (
        state.ok && state.token ? (
          // The one time the token exists outside its hash: a plate that says so, names it and
          // carries its mark, lit, so it can be found in the list once the plate is gone.
          <div role="status" className="rounded-sm border border-ink bg-bg">
            <p className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-2">
              <span className="flex min-w-0 items-center gap-2">
                <span className="label-mono shrink-0 text-accent-ink">Shown once</span>
                <TokenMark hint={state.token.slice(0, 10)} lit className="size-5 sm:hidden" />
                <span className="min-w-0 truncate text-14 font-medium">{state.name}</span>
              </span>
              <span className="text-12 text-ink-3 tnum">
                {state.expiresAt ? `expires ${formatUtc(state.expiresAt, { time: false })}` : "does not expire"}
              </span>
            </p>
            <div className="flex items-start gap-4 px-4 py-4">
              <TokenMark hint={state.token.slice(0, 10)} lit className="size-14 max-sm:hidden" />
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <code className="min-w-0 flex-1 basis-full break-all rounded-sm sm:basis-0 border border-rule bg-surface px-3 py-2 font-mono text-15 tracking-wide">
                    {state.token}
                  </code>
                  <CopyButton text={state.token} label="Copy token" />
                </div>
                <p className="text-13 text-ink-2">{state.message}</p>
              </div>
            </div>
          </div>
        ) : (
          <div role="status" className={`flex flex-col gap-2 rounded-sm border-y border-r border-l-4 px-4 py-3 text-14 ${state.ok ? "border-ok" : "border-flag-bar bg-flag-bg"}`}>
            <p>{state.message}</p>
          </div>
        )
      ) : null}
    </form>
  );
}
