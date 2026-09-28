"use client";

import { Copy, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useFormAction } from "@/components/use-form-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ActionResult, MyTeam } from "@/server/dal";
import { createTeamAction, rotateInviteAction, teamMemberAction } from "./actions";

const noSubscription = () => () => {};

/** The team block of the side column: members, and for the captain the invite link. */
export function TeamPanel({ team, eventSlug, open, me }: { team: MyTeam; eventSlug: string; open: boolean; me: string }) {
  const [state, form, pending] = useFormAction<ActionResult>(rotateInviteAction, { ok: false, message: null });
  const [change, changeForm, changing] = useFormAction<ActionResult>(teamMemberAction, { ok: false, message: null });
  const captain = team.role === "captain";
  const [copied, setCopied] = useState(false);
  // Leaving and removing ask once more: one click used to drop a teammate, or yourself, from the
  // team and its project at once (a tester left by accident).
  const [confirming, setConfirming] = useState<string | null>(null);
  // The full link needs this page's address, which only the browser knows: the server
  // renders the short path and the browser fills in the rest after hydration.
  const origin = useSyncExternalStore(noSubscription, () => window.location.origin, () => null);
  const link = team.inviteCode && origin ? `${origin}/join/${team.inviteCode}` : null;
  return (
    <section aria-labelledby="team-title">
      <h2 id="team-title" className="label-mono text-ink-2 wrap-anywhere">
        Team {team.name}
      </h2>
      <ul className="mt-3 flex flex-col gap-1.5">
        {team.members.map((m) => (
          <li key={m.userId} className="flex flex-col gap-1 text-14">
            <span className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 wrap-anywhere">{m.name}</span>
              <span className="shrink-0 text-12 text-ink-3">{m.role}</span>
            </span>
            {open && captain && m.userId !== me ? (
              <form {...changeForm} className="flex gap-1">
                <input type="hidden" name="team" value={team.id} />
                <input type="hidden" name="user" value={m.userId} />
                <input type="hidden" name="event" value={eventSlug} />
                <Button variant="ghost" size="sm" name="do" value="captain" disabled={changing} className="-ml-2.5 h-7 text-13">
                  Make captain
                </Button>
                {confirming === `remove:${m.userId}` ? (
                  <>
                    <Button variant="ghost" size="sm" name="do" value="remove" disabled={changing} className="h-7 text-13 text-flag">
                      Yes, remove {m.name.split(" ")[0]}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)} className="h-7 text-13">
                      Keep
                    </Button>
                  </>
                ) : (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(`remove:${m.userId}`)} className="h-7 text-13">
                    Remove
                  </Button>
                )}
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {open && !captain ? (
        <form {...changeForm} className="mt-3">
          <input type="hidden" name="team" value={team.id} />
          <input type="hidden" name="event" value={eventSlug} />
          {confirming === "leave" ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-13 text-ink-2">Leave {team.name}? You lose the project with it; the invite link brings you back.</p>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" name="do" value="leave" disabled={changing} className="-ml-2.5 text-flag">
                  Yes, leave
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                  Stay
                </Button>
              </div>
            </div>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming("leave")} className="-ml-2.5">
              Leave team
            </Button>
          )}
        </form>
      ) : null}
      {open && captain && team.members.length > 1 ? <p className="mt-2 text-12 text-ink-3">To leave, make another member captain first.</p> : null}
      {change.message ? (
        <p aria-live="polite" className={`mt-2 text-13 ${change.ok ? "text-ink-2" : "text-flag"}`}>
          {change.message}
        </p>
      ) : null}
      {!open ? (
        <p className="mt-3 border-t border-rule pt-3 text-12 text-ink-3">The team was fixed when submissions closed, so the invite link no longer works.</p>
      ) : team.inviteCode ? (
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
          {/* A phone cuts the link off inside the box; the whole link, wrapped, so it can be read before it is sent. */}
          <p aria-hidden className="font-mono text-12 break-all text-ink-2 sm:hidden">
            {link ?? `/join/${team.inviteCode}`}
          </p>
          <p aria-live="polite" className="text-12 text-ink-3">
            {copied ? "Copied." : state.message ?? "Anyone with this link can join while submissions are open."}
          </p>
          <form {...form}>
            <input type="hidden" name="team" value={team.id} />
            <input type="hidden" name="event" value={eventSlug} />
            <Button variant="ghost" size="sm" disabled={pending} className="-ml-2.5">
              <RefreshCw aria-hidden /> Make a new link
            </Button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

/** For someone signed in with no team yet: start one (or open a captain's link); after the close, say so and point on. */
export function StartTeam({
  eventSlug,
  open,
  closedLabel,
  published = false,
}: {
  eventSlug: string;
  open: boolean;
  closedLabel?: string;
  published?: boolean;
}) {
  const [state, form, pending] = useFormAction<ActionResult>(createTeamAction, { ok: false, message: null });
  if (!open) {
    const link = "inline-flex h-10 items-center rounded-sm border border-edge px-4 text-14 font-medium hover:bg-sunken";
    return (
      <section aria-labelledby="closed-title" className="corner-marks max-w-[760px] rounded-sm border border-rule px-6 py-8 sm:px-10 sm:py-10">
        <p className="label-mono text-ink-3">Submissions closed{closedLabel ? ` · ${closedLabel}` : ""}</p>
        <h2 id="closed-title" className="mt-3 text-24 leading-8 font-semibold">
          Teams could form until submissions closed.
        </h2>
        <p className="mt-2 max-w-[600px] text-15 text-ink-2">
          You are not on a team in this event, so there is no project of yours here. You can still read every project that was handed in
          {published ? " and see the results." : "."}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href={`/events/${eventSlug}`} className={link}>
            See the projects
          </Link>
          {published ? (
            <Link href={`/events/${eventSlug}/results`} className={link}>
              See the results
            </Link>
          ) : null}
        </div>
      </section>
    );
  }
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
