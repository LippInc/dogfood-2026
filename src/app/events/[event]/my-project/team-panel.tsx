"use client";

import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult, MyTeam } from "@/server/dal";
import { createTeamAction, rotateInviteAction } from "./actions";

/** The team block of the side column: members, and for the captain the invite link. */
export function TeamPanel({ team, eventSlug, open }: { team: MyTeam; eventSlug: string; open: boolean }) {
  const [state, form, pending] = useFormAction<ActionResult>(rotateInviteAction, { ok: false, message: null });
  const [copied, setCopied] = useState(false);
  const link = team.inviteCode && typeof window !== "undefined" ? `${window.location.origin}/join/${team.inviteCode}` : null;
  return (
    <section aria-labelledby="team-title">
      <h2 id="team-title" className="label-mono text-ink-2 wrap-anywhere">
        Team {team.name}
      </h2>
      <ul className="mt-3 flex flex-col gap-1.5">
        {team.members.map((m, i) => (
          <li key={`${m.name}-${i}`} className="flex items-baseline justify-between gap-3 text-14">
            <span className="min-w-0 wrap-anywhere">{m.name}</span>
            <span className="shrink-0 text-12 text-ink-3">{m.role}</span>
          </li>
        ))}
      </ul>
      {team.inviteCode ? (
        <div className="mt-4 flex flex-col gap-2">
          <label htmlFor="invite" className="text-13 text-ink-2">
            Invite link for teammates
          </label>
          <div className="flex gap-2">
            <Input
              id="invite"
              readOnly
              value={link ?? `/join/${team.inviteCode}`}
              className="h-9 font-mono text-12"
              onFocus={(e) => e.currentTarget.select()}
              suppressHydrationWarning
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-9"
              aria-label="Copy the invite link"
              onClick={async () => {
                await navigator.clipboard.writeText(link ?? `/join/${team.inviteCode}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              <Copy aria-hidden />
            </Button>
          </div>
          <p aria-live="polite" className="text-12 text-ink-3">
            {copied ? "Copied." : state.message ?? "Anyone with this link can join while submissions are open."}
          </p>
          {open ? (
            <form {...form}>
              <input type="hidden" name="team" value={team.id} />
              <input type="hidden" name="event" value={eventSlug} />
              <Button variant="ghost" size="sm" disabled={pending} className="-ml-2.5">
                <RefreshCw aria-hidden /> Make a new link
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** For someone signed in with no team yet: start one (or open a captain's link). */
export function StartTeam({ eventSlug, open }: { eventSlug: string; open: boolean }) {
  const [state, form, pending] = useFormAction<ActionResult>(createTeamAction, { ok: false, message: null });
  return (
    <div className="grid gap-8 md:grid-cols-2">
      <section aria-labelledby="start-title" className="rounded-sm border border-rule bg-surface p-6">
        <h2 id="start-title" className="text-20 font-semibold">
          Start a team
        </h2>
        <p className="mt-1 text-14 text-ink-2">You become its captain and get an invite link to share.</p>
        <form {...form} className="mt-5 flex flex-col gap-3">
          <input type="hidden" name="event" value={eventSlug} />
          <label htmlFor="team-name" className="text-14 font-medium">
            Team name
          </label>
          <Input id="team-name" name="name" maxLength={60} disabled={!open} aria-invalid={state.fieldErrors?.name ? true : undefined} />
          <Button size="lg" disabled={!open || pending}>
            {pending ? "Creating…" : "Create team"}
          </Button>
          {state.message ? (
            <p role="status" className={state.ok ? "text-14 text-ok" : "text-14 text-flag"}>
              {state.fieldErrors?.name?.[0] ?? state.message}
            </p>
          ) : null}
        </form>
      </section>
      <section aria-labelledby="join-title" className="rounded-sm border border-rule p-6">
        <h2 id="join-title" className="text-20 font-semibold">
          Join a team
        </h2>
        <p className="mt-1 text-14 text-ink-2">
          Ask your captain for the invite link and open it. It looks like{" "}
          <span className="font-mono text-13">/join/k3x9…</span>. One person can be on one team per event.
        </p>
      </section>
    </div>
  );
}
