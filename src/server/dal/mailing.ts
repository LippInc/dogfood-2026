import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { outbox, type MailKind } from "../db/schema";
import { mailBase, mailSettings, sendMany } from "../mail";
import { HttpError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { newId, nowIso } from "../util";
import { CLAIM_DAYS } from "./claims";
import { eventFacts, requireEvent } from "./events";
import { RESET_HOURS } from "./password-resets";

// Email, sending side. The portal mails each link when it is made and keeps no key: the function that
// makes a link commits and returns it once, as before; the route or form that called it then hands the
// link here. Each message is first recorded in the outbox as "sending", with the link blanked, in one
// audited write, so the database never holds a working key and no message goes out unrecorded; only then
// is it sent (only when SMTP_URL is set), and a second audited write marks each row sent, failed (it did
// not go out) or unknown (the connection broke after it may have been handed over). A row left at
// "sending" means the portal stopped before the mail server answered. A message cannot be mailed again
// later; making a new link is how to send again. With email off nothing is sent or recorded, and each
// screen shows the link to copy, as it always has.

export type Mailed = { to: string; status: "sent" | "failed" | "unknown"; error?: string };
/** on: false, email is off; on: true with an empty list, there was no address to mail. */
export type MailReport = { on: boolean; mailed: Mailed[] };

/** What stands in for the link in the copy the outbox keeps. */
export const BLANKED = "[the link, shown once on the screen that made it]";

/** The outbox's own limits (schema.ts, outbox_subject_length and outbox_body_length). */
export const SUBJECT_MAX = 200;
const BODY_MAX = 20_000;

/** A subject that fits the outbox (an imported event's name is not held to the form's 80 characters): the mail
 *  and its record carry the same words, cut with an ellipsis. */
export function fitSubject(subject: string): string {
  const one = subject.replace(/[\r\n]+/g, " ");
  return one.length > SUBJECT_MAX ? `${one.slice(0, SUBJECT_MAX - 1)}…` : one;
}

type Letter = { to: string; subject: string; body: (link: string) => string; path: string };
type Scope = { eventIdOrSlug: string } | { portal: true };

const emailOn = () => mailSettings().on;
const isAddress = (to: string) => z.email().safeParse(to.trim()).success;

async function mailLetters(actor: Actor | null, scope: Scope, kind: MailKind, all: Letter[]): Promise<MailReport> {
  const portal = "portal" in scope;
  const action = portal ? "portal.accounts" : "event.manage";
  const load = (tx: Parameters<typeof requireEvent>[0]) =>
    portal ? ({ kind: "platform" } as const) : ({ kind: "event", event: eventFacts(requireEvent(tx, scope.eventIdOrSlug)) } as const);
  // decided (and a refusal audited) before anything is recorded or sent, with the question the writes ask again
  guardRead(actor, action, load(getDb()), new Date(), "write");
  if (!emailOn()) return { on: false, mailed: [] };
  // an address the mail server would never be offered is said at once; it has no row, as it had no send
  const letters = all.filter((l) => isAddress(l.to)).map((l) => ({ ...l, subject: fitSubject(l.subject) }));
  const refused: Mailed[] = all.filter((l) => !isAddress(l.to)).map((l) => ({ to: l.to, status: "failed", error: "that is not an email address" }));
  if (!letters.length) return { on: true, mailed: refused };
  const ids = letters.map(() => newId("mail"));
  const now = nowIso();

  // 1. the record, before anything is sent. If it cannot be written nothing is sent: the page that made the
  //    links still shows them (their only copy), each with the reason it was not mailed.
  try {
    mutate({
      actor,
      action,
      load,
      run: (tx) => {
        const eventId = portal ? null : requireEvent(tx, scope.eventIdOrSlug).id;
        letters.forEach((l, i) => {
          tx.insert(outbox)
            .values({
              id: ids[i]!,
              eventId,
              kind,
              toEmail: l.to,
              subject: l.subject,
              body: l.body(BLANKED).slice(0, BODY_MAX),
              status: "sending",
              error: null,
              createdBy: actor?.userId ?? null,
              createdAt: now,
              sentAt: null,
            })
            .run();
        });
        return { result: undefined, audit: { action: "mail.sent", eventId, targetType: "outbox", targetId: kind, after: { kind, sending: letters.length } } };
      },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err; // a refusal, as guardRead would have given it
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[mail] ${letters.length} ${kind} message(s) not sent: the outbox could not record them: ${why}`);
    return { on: true, mailed: [...letters.map((l): Mailed => ({ to: l.to, status: "failed", error: "not sent: the portal could not record it first" })), ...refused] };
  }

  // 2. the sends
  const base = mailBase();
  const results = await sendMany(letters.map((l) => ({ to: l.to, subject: l.subject, text: l.body(base + l.path) })));
  const mailed: Mailed[] = results.map((r, i) => {
    const to = letters[i]!.to;
    if (r.status === "sent") return { to, status: "sent" };
    if (r.status === "unknown") return { to, status: "unknown", error: r.error };
    return { to, status: "failed", error: r.status === "failed" ? r.error : "email is off" };
  });
  const count = (s: Mailed["status"]) => mailed.filter((m) => m.status === s).length;

  // 3. the outcome, on the rows written in 1. If this write fails the rows keep saying "sending", which the
  //    outbox shows as "no answer recorded": the record is never lost, only its last word.
  try {
    mutate({
      actor,
      action,
      load,
      run: (tx) => {
        const eventId = portal ? null : requireEvent(tx, scope.eventIdOrSlug).id;
        results.forEach((r, i) => {
          tx.update(outbox)
            .set({
              status: r.status === "sent" ? "sent" : r.status === "unknown" ? "unknown" : "failed",
              error: r.status === "sent" ? null : mailed[i]!.error!,
              sentAt: r.status === "sent" ? r.sentAt : null,
            })
            .where(eq(outbox.id, ids[i]!))
            .run();
        });
        const unknown = count("unknown");
        const after = { kind, sent: count("sent"), failed: count("failed"), ...(unknown ? { unknown } : {}) };
        return { result: undefined, audit: { action: "mail.sent", eventId, targetType: "outbox", targetId: kind, after } };
      },
    });
  } catch (err) {
    console.error(`[mail] the outcome of ${letters.length} ${kind} message(s) was not recorded; their rows still say sending: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { on: true, mailed: [...mailed, ...refused] };
}

const eventName = (eventIdOrSlug: string) => requireEvent(getDb(), eventIdOrSlug).name;

/** Judges' invitations, each to the address the organizer gave (none given: nothing to mail for that one). */
export function mailJudgeInvites(actor: Actor | null, eventIdOrSlug: string, invites: { email: string | null; path: string }[]): Promise<MailReport> {
  const name = eventName(eventIdOrSlug);
  const from = actor?.name ?? "The organizers";
  const letters: Letter[] = invites.flatMap((invite) =>
    invite.email
      ? [
          {
            to: invite.email,
            subject: `You are invited to judge ${name}`,
            body: (link: string) =>
              `${from} invited you to judge ${name}.\n\nOpen this link to accept the invitation:\n${link}\n\nThe link is yours alone and works once. If it has stopped working, ask ${from} for a new one.\n`,
            path: invite.path,
          },
        ]
      : [],
  );
  return mailLetters(actor, { eventIdOrSlug }, "judge_invite", letters);
}

/** A judge's invitation, to the address the organizer gave (none given: nothing to mail). */
export function mailJudgeInvite(actor: Actor | null, eventIdOrSlug: string, invite: { email: string | null; path: string }): Promise<MailReport> {
  return mailJudgeInvites(actor, eventIdOrSlug, [invite]);
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
