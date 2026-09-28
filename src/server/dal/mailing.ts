import "server-only";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { outbox, type MailKind } from "../db/schema";
import { mailBase, mailSettings, sendMany } from "../mail";
import { guardRead, mutate } from "../mutate";
import { newId, nowIso } from "../util";
import { CLAIM_DAYS } from "./claims";
import { eventFacts, requireEvent } from "./events";
import { RESET_HOURS } from "./password-resets";

// Email, sending side. The portal mails each link when it is made and keeps no key: the function that
// makes a link commits and returns it once, as before; the route or form that called it then hands the
// link here. The message is sent (only when SMTP_URL is set), then recorded in the outbox with the link
// blanked, in one audited write, so the database never holds a working key. A message cannot be mailed
// again later; making a new link is how to send again. With email off nothing is sent or recorded, and
// each screen shows the link to copy, as it always has.

export type Mailed = { to: string; status: "sent" | "failed"; error?: string };
/** on: false, email is off; on: true with an empty list, there was no address to mail. */
export type MailReport = { on: boolean; mailed: Mailed[] };

/** What stands in for the link in the copy the outbox keeps. */
export const BLANKED = "[the link, shown once on the screen that made it]";

type Letter = { to: string; subject: string; body: (link: string) => string; path: string };
type Scope = { eventIdOrSlug: string } | { portal: true };

const emailOn = () => mailSettings().on;

async function mailLetters(actor: Actor | null, scope: Scope, kind: MailKind, letters: Letter[]): Promise<MailReport> {
  const portal = "portal" in scope;
  const action = portal ? "portal.accounts" : "event.manage";
  // decided (and a refusal audited) before anything is sent, with the question the recording write asks again
  guardRead(actor, action, portal ? { kind: "platform" } : { kind: "event", event: eventFacts(requireEvent(getDb(), scope.eventIdOrSlug)) }, new Date(), "write");
  if (!emailOn()) return { on: false, mailed: [] };
  if (!letters.length) return { on: true, mailed: [] };
  const base = mailBase();
  const results = await sendMany(letters.map((l) => ({ to: l.to, subject: l.subject, text: l.body(base + l.path) })));
  const mailed: Mailed[] = results.map((r, i) =>
    r.status === "sent" ? { to: letters[i]!.to, status: "sent" } : { to: letters[i]!.to, status: "failed", error: r.status === "failed" ? r.error : "email is off" },
  );
  const sent = mailed.filter((m) => m.status === "sent").length;
  const now = nowIso();
  mutate({
    actor,
    action,
    load: (tx) => (portal ? { kind: "platform" } : { kind: "event", event: eventFacts(requireEvent(tx, scope.eventIdOrSlug)) }),
    run: (tx) => {
      const eventId = portal ? null : requireEvent(tx, scope.eventIdOrSlug).id;
      letters.forEach((l, i) => {
        const r = results[i]!;
        tx.insert(outbox)
          .values({
            id: newId("mail"),
            eventId,
            kind,
            toEmail: l.to,
            subject: l.subject,
            body: l.body(BLANKED),
            status: r.status === "sent" ? "sent" : "failed",
            error: r.status === "sent" ? null : mailed[i]!.error!,
            createdBy: actor?.userId ?? null,
            createdAt: now,
            sentAt: r.status === "sent" ? r.sentAt : null,
          })
          .run();
      });
      return { result: undefined, audit: { action: "mail.sent", eventId, targetType: "outbox", targetId: kind, after: { kind, sent, failed: letters.length - sent } } };
    },
  });
  return { on: true, mailed };
}

const eventName = (eventIdOrSlug: string) => requireEvent(getDb(), eventIdOrSlug).name;

/** A judge's invitation, to the address the organizer gave (none given: nothing to mail). */
export function mailJudgeInvite(actor: Actor | null, eventIdOrSlug: string, invite: { email: string | null; path: string }): Promise<MailReport> {
  const name = eventName(eventIdOrSlug);
  const from = actor?.name ?? "The organizers";
  const letters: Letter[] = invite.email
    ? [
        {
          to: invite.email,
          subject: `You are invited to judge ${name}`,
          body: (link) =>
            `${from} invited you to judge ${name}.\n\nOpen this link to accept the invitation:\n${link}\n\nThe link is yours alone and works once. If it has stopped working, ask ${from} for a new one.\n`,
          path: invite.path,
        },
      ]
    : [];
  return mailLetters(actor, { eventIdOrSlug }, "judge_invite", letters);
}

/** Each listed voter's personal link. */
export function mailVoterLinks(actor: Actor | null, eventIdOrSlug: string, links: { email: string; path: string }[]): Promise<MailReport> {
  const name = eventName(eventIdOrSlug);
  const letters: Letter[] = links.map((l) => ({
    to: l.email,
    subject: `Your voting link for ${name}`,
    body: (link) =>
      `You are on the voter list for the community vote of ${name}.\n\nYour personal link:\n${link}\n\nIt is yours alone: whoever opens it votes as you, so please do not forward this mail.\n`,
    path: l.path,
  }));
  return mailLetters(actor, { eventIdOrSlug }, "voter_link", letters);
}

/** Each imported person's link to set a password and take over their account. */
export function mailClaimLinks(actor: Actor | null, eventIdOrSlug: string, links: { email: string; path: string }[]): Promise<MailReport> {
  const name = eventName(eventIdOrSlug);
  const from = actor?.name ?? "The organizers";
  const letters: Letter[] = links.map((l) => ({
    to: l.email,
    subject: `Your account for ${name}`,
    body: (link) =>
      `${from} set up an account for you on the portal of ${name}, with your team's project.\n\nSet your password here (the link works for ${CLAIM_DAYS} days):\n${link}\n`,
    path: l.path,
  }));
  return mailLetters(actor, { eventIdOrSlug }, "claim_link", letters);
}

/** A password reset link, only ever to the account's own address. */
export function mailPasswordReset(actor: Actor | null, reset: { email: string; path: string }): Promise<MailReport> {
  const letters: Letter[] = [
    {
      to: reset.email,
      subject: "Set a new password",
      body: (link) =>
        `An administrator made you a link to set a new password on the portal.\n\nThe link works once, within ${RESET_HOURS} hours:\n${link}\n\nIf you did not ask for this, you can ignore this mail; your password stays as it is.\n`,
      path: reset.path,
    },
  ];
  return mailLetters(actor, { portal: true }, "password_reset", letters);
}

/** Whether the portal mails the links it makes (SMTP_URL is set), for the screens' own words. */
export function emailIsOn(): boolean {
  return emailOn();
}
