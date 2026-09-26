"use client";

import { useActionState, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CopyButton } from "../judges/forms";
import { addWebhookAction, rotateSecretAction, type SecretResult } from "./actions";

const idle: SecretResult = { ok: false, message: null };

export const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  { label: "Teams and projects", actions: ["team.create", "team.join", "project.create", "project.edit"] },
  { label: "Judging", actions: ["judge.join", "assignment.run", "assignment.by_hand", "review.save", "review.recuse"] },
  { label: "Results", actions: ["judge.override", "project.merge", "project.not_duplicate", "project.accept_under_reviewed", "results.publish"] },
  { label: "Community vote and comments", actions: ["vote.cast", "voter.void", "comment.post", "comment.hide"] },
  { label: "Records", actions: ["record.issue"] },
  { label: "Refused requests", actions: ["authz.refused", "ratelimit.refused"] },
];

function Secret({ state }: { state: SecretResult }) {
  if (!state.message) return null;
  return (
    <div role="status" className={`flex flex-col gap-2 rounded-sm border-y border-r border-l-4 px-4 py-3 text-14 ${state.ok ? "border-ok" : "border-flag-bar bg-flag-bg"}`}>
      <p>{state.message}</p>
      {state.secret ? (
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all rounded-sm bg-sunken px-2 py-1 font-mono text-13">{state.secret}</code>
          <CopyButton text={state.secret} label="Copy secret" />
        </div>
      ) : null}
    </div>
  );
}

export function AddWebhookForm({ eventSlug }: { eventSlug: string }) {
  const [state, action, pending] = useActionState(addWebhookAction, idle);
  const [every, setEvery] = useState(true);
  const e = state.fieldErrors ?? {};
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="event" value={eventSlug} />
      <Field id="webhook-url" label="Send to (URL)" error={e.url} help="The portal POSTs JSON there, signed with the webhook's secret.">
        {(a) => <Input {...a} name="url" type="url" required placeholder="https://example.org/hooks/dogfood" className="max-w-[560px]" />}
      </Field>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-14 font-medium">What to send</legend>
        <label className="flex items-center gap-2 text-14">
          <input type="checkbox" name="actions" value="*" checked={every} onChange={(ev) => setEvery(ev.target.checked)} className="size-4 accent-[var(--primary)]" />
          <span className="font-medium">Every audited action</span>
        </label>
        {every ? null : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {ACTION_GROUPS.map((g) => (
              <div key={g.label} className="flex flex-col gap-1.5">
                <p className="text-13 text-ink-2">{g.label}</p>
                {g.actions.map((a) => (
                  <label key={a} className="flex items-center gap-2">
                    <input type="checkbox" name="actions" value={a} className="size-4 accent-[var(--primary)]" />
                    <code className="font-mono text-12">{a}</code>
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
        {e.actions ? <p className="text-13 text-flag">{e.actions}</p> : null}
      </fieldset>
      <div>
        <Button disabled={pending}>Add webhook</Button>
      </div>
      <Secret state={state} />
    </form>
  );
}

export function RotateSecretForm({ eventSlug, webhookId }: { eventSlug: string; webhookId: string }) {
  const [state, action, pending] = useActionState(rotateSecretAction, idle);
  return (
    <form action={action} className="contents">
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="webhook" value={webhookId} />
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        New secret
      </Button>
      {state.message ? (
        <div className="basis-full">
          <Secret state={state} />
        </div>
      ) : null}
    </form>
  );
}
