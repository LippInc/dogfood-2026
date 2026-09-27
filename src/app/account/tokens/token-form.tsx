"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "../../organize/[event]/judges/forms";
import { createTokenAction, type TokenResult } from "./actions";

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
          // The one time the token exists outside its hash: a plate that says so.
          <div role="status" className="rounded-sm border border-ink bg-bg">
            <p className="flex items-center justify-between gap-3 border-b border-rule px-4 py-2">
              <span className="label-mono text-accent-ink">Shown once</span>
              <span className="text-12 text-ink-3">the portal keeps only its hash</span>
            </p>
            <div className="flex flex-col gap-3 px-4 py-4">
              <p className="text-14">{state.message}</p>
              <div className="flex flex-wrap items-center gap-3">
                <code className="min-w-0 flex-1 break-all rounded-sm border border-rule bg-surface px-3 py-2 font-mono text-15 tracking-wide">{state.token}</code>
                <CopyButton text={state.token} label="Copy token" />
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
