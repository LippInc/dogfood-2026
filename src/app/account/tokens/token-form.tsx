"use client";

import { useFormAction } from "@/components/use-form-action";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "../../organize/[event]/judges/forms";
import { createTokenAction, type TokenResult } from "./actions";

const idle: TokenResult = { ok: false, message: null };

export function TokenForm() {
  const [state, action, pending] = useFormAction(createTokenAction, idle);
  const e = state.fieldErrors ?? {};
  return (
    <form {...action} className="flex flex-col gap-4">
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
        <Button disabled={pending}>Make a token</Button>
      </div>
      {state.message ? (
        <div role="status" className={`flex flex-col gap-2 rounded-sm border-y border-r border-l-4 px-4 py-3 text-14 ${state.ok ? "border-ok" : "border-flag-bar bg-flag-bg"}`}>
          <p>{state.message}</p>
          {state.token ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all rounded-sm bg-sunken px-2 py-1 font-mono text-13">{state.token}</code>
              <CopyButton text={state.token} label="Copy token" />
            </div>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
