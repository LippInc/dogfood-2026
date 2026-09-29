import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type Tx } from "../db/client";
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
// audited write, so the database never holds a working key and no message goes out unrecorded (an address the
// mail server would never be offered is recorded in the same write as failed, with its reason); only then
// is it sent (only when SMTP_URL is set), and a second audited write marks each row sent, failed (it did
// not go out) or unknown (the connection broke after it may have been handed over). A row left at
// "sending" means the portal stopped before the mail server answered. The page waits at most MAIL_WAIT_MS for
// the sends, then answers with the links (their only copy) while the rest finish. A message cannot be mailed again
// later; making a new link is how to send again. With email off nothing is sent or recorded, and each
// screen shows the link to copy, as it always has.

/** pending: still being sent when the page answered (a slow mail server); the outbox shows its result once it has one. */
export type Mailed = { to: string; status: "sent" | "failed" | "unknown" | "pending"; error?: string };
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

/** How long the page that made the links waits for the mail server before it answers anyway: the links are its
 *  only copy, so they never wait behind a slow server. The sends go on after the answer, within sendMany's own
 *  budget, and write their outcome to the rows recorded before them. */
export const MAIL_WAIT_MS = 5_000;
let waitMs = MAIL_WAIT_MS;
/** Tests shorten the wait; null puts it back. */
export function setMailWaitForTests(ms: number | null): void {
  waitMs = ms ?? MAIL_WAIT_MS;
}

/** keepLink: the link is public (an event's updates page, a judge's console), so the outbox copy keeps it. */
type Letter = { to: string; subject: string; body: (link: string) => string; path: string; keepLink?: boolean };
type Scope = { eventIdOrSlug: string } | { portal: true };

const emailOn = () => mailSettings().on;
const isAddress = (to: string) => z.email().safeParse(to.trim()).success;
/** The outbox's own rule for to_email (schema.ts, outbox_to_email): a refused address outside it is only said on the page. */
const fitsOutbox = (to: string) => /[\s\S]@[\s\S]/.test(to);
/** Why an address is never offered to the mail server. */
const REFUSED = "that is not an email address";

/** gate: run inside the write that records the letters, before it does; it may throw (a reminder mailed too soon). */
async function mailLetters(actor: Actor | null, scope: Scope, kind: MailKind, all: Letter[], gate?: (tx: Tx) => void): Promise<MailReport> {
  const portal = "portal" in scope;
  const action = portal ? "portal.accounts" : "event.manage";
  const load = (tx: Parameters<typeof requireEvent>[0]) =>
    portal ? ({ kind: "platform" } as const) : ({ kind: "event", event: eventFacts(requireEvent(tx, scope.eventIdOrSlug)) } as const);
  // decided (and a refusal audited) before anything is recorded or sent, with the question the writes ask again
  guardRead(actor, action, load(getDb()), new Date(), "write");
  if (!emailOn()) return { on: false, mailed: [] };
  // an address the mail server would never be offered is failed at once, and recorded with the rest as failed, with
  // its reason, so the outbox holds every address the organizer meant to mail
  const letters = all.filter((l) => isAddress(l.to)).map((l) => ({ ...l, subject: fitSubject(l.subject) }));
  const refusedLetters = all.filter((l) => !isAddress(l.to)).map((l) => ({ ...l, subject: fitSubject(l.subject) }));
  const refused: Mailed[] = refusedLetters.map((l) => ({ to: l.to, status: "failed", error: REFUSED }));
  const recordRefused = refusedLetters.filter((l) => fitsOutbox(l.to));
  if (!letters.length && !recordRefused.length) return { on: true, mailed: refused };
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
        gate?.(tx);
        const eventId = portal ? null : requireEvent(tx, scope.eventIdOrSlug).id;
        const base = mailBase();
        const row = (l: Letter, id: string, status: "sending" | "failed", error: string | null) =>
          tx.insert(outbox)
            .values({
              id,
              eventId,
              kind,
              toEmail: l.to,
              subject: l.subject,
              body: l.body(l.keepLink ? base + l.path : BLANKED).slice(0, BODY_MAX),
              status,
              error,
              createdBy: actor?.userId ?? null,
              createdAt: now,
              sentAt: null,
            })
            .run();
        letters.forEach((l, i) => row(l, ids[i]!, "sending", null));
        recordRefused.forEach((l) => row(l, newId("mail"), "failed", REFUSED));
        const after = { kind, sending: letters.length, ...(recordRefused.length ? { refused: recordRefused.length } : {}) };
        return { result: undefined, audit: { action: "mail.sent", eventId, targetType: "outbox", targetId: kind, after } };
      },
    });
  } catch (err) {
    if (err instanceof HttpError) throw err; // a refusal, as guardRead would have given it
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[mail] ${letters.length} ${kind} message(s) not sent: the outbox could not record them: ${why}`);
    return { on: true, mailed: [...letters.map((l): Mailed => ({ to: l.to, status: "failed", error: "not sent: the portal could not record it first" })), ...refused] };
  }
  if (!letters.length) return { on: true, mailed: refused };

  // 2. the sends and 3. their outcome, waited for at most waitMs; past that the page answers with the links and
  //    "pending", and the sends finish on their own (they never throw: every failure is caught and logged).
  const base = mailBase();
  const finished = sendAndRecord(actor, scope, kind, action, load, letters, ids, base).catch((err: unknown) => {
    console.error(`[mail] ${letters.length} ${kind} message(s): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), waitMs);
    timer.unref?.();
  });
  const mailed = await Promise.race([finished, late]);
  clearTimeout(timer);
  if (mailed) return { on: true, mailed: [...mailed, ...refused] };
  return { on: true, mailed: [...letters.map((l): Mailed => ({ to: l.to, status: "pending" })), ...refused] };
}

async function sendAndRecord(
  actor: Actor | null,
  scope: Scope,
  kind: MailKind,
  action: "portal.accounts" | "event.manage",
  load: (tx: Parameters<typeof requireEvent>[0]) => ReturnType<Parameters<typeof mutate>[0]["load"]>,
  letters: Letter[],
  ids: string[],
  base: string,
): Promise<Mailed[]> {
  const portal = "portal" in scope;
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
  return mailed;
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

/** An organizer's update, to each address given (the event's participants), with the event's updates page. */
export function mailEventUpdate(actor: Actor | null, eventIdOrSlug: string, update: { title: string; body: string }, to: string[]): Promise<MailReport> {
  const event = requireEvent(getDb(), eventIdOrSlug);
  const letters: Letter[] = to.map((address) => ({
    to: address,
    subject: `${event.name}: ${update.title}`,
    body: (link) =>
      `${update.title}\n\n${update.body}\n\n-- \nAn update from the organizers of ${event.name}. Every update: ${link}\nYou get this because you are on a team in ${event.name}.\n`,
    path: `/events/${event.slug}/updates`,
    keepLink: true,
  }));
  return mailLetters(actor, { eventIdOrSlug }, "event_update", letters);
}

/** Reminders to judges, each with the words its copy button gives (text, from the judge's console address); gate runs inside the recording write. */
export function mailJudgeReminders(
  actor: Actor | null,
  eventIdOrSlug: string,
  reminders: { to: string; text: (consoleUrl: string) => string }[],
  gate: (tx: Tx) => void,
): Promise<MailReport> {
  const event = requireEvent(getDb(), eventIdOrSlug);
  const letters: Letter[] = reminders.map((r) => ({
    to: r.to,
    subject: `A reminder: your reviews for ${event.name}`,
    body: (link) => `${r.text(link)}\n`,
    path: `/judge/${event.slug}`,
    keepLink: true,
  }));
  return mailLetters(actor, { eventIdOrSlug }, "judge_reminder", letters, gate);
}

/** Whether the portal mails the links it makes (SMTP_URL is set), for the screens' own words. */
export function emailIsOn(): boolean {
  return emailOn();
}
