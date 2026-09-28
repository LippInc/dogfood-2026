import "server-only";
import nodemailer from "nodemailer";
import { z } from "zod";
import { nowIso } from "./util";

// Email, off by default: with SMTP_URL unset the portal mails nothing and `docker compose up` stays
// offline, and each link is shown once on the screen that made it, as before. With SMTP_URL set
// (smtp://user:pass@host:587 or smtps://...) and MAIL_FROM, messages go out through that server.
// nodemailer builds the headers; a line break in an address or a subject is refused before it is
// handed over, so nothing a person typed can add a header.

/** The two settings mail reads: process.env at run time, a plain object in tests. */
export type MailEnv = { SMTP_URL?: string; MAIL_FROM?: string; [name: string]: string | undefined };

export type MailSettings = { on: false } | { on: true; url: string; from: string };

/** Null when the mail settings are usable (or email is off); otherwise a sentence naming the setting to fix. */
export function mailProblem(env: MailEnv = process.env): string | null {
  const url = env.SMTP_URL?.trim();
  if (!url) return null;
  if (!/^smtps?:\/\/[^/\s]/i.test(url)) return "SMTP_URL must start with smtp:// or smtps:// and name a mail server, as in smtp://user:password@mail.example.org:587";
  const from = env.MAIL_FROM?.trim();
  if (!from || !from.includes("@") || /[\r\n]/.test(from)) return "MAIL_FROM must be the address the portal mails from, as in portal@example.org, when SMTP_URL is set";
  return null;
}

export function mailSettings(env: MailEnv = process.env): MailSettings {
  const problem = mailProblem(env);
  if (problem) throw new Error(problem);
  const url = env.SMTP_URL?.trim();
  return url ? { on: true, url, from: (env.MAIL_FROM ?? "").trim() } : { on: false };
}

export type SendResult = { status: "off" } | { status: "sent"; sentAt: string } | { status: "failed"; error: string };

type Message = { from: string; to: string; subject: string; text: string };
type Transport = { sendMail(message: Message): Promise<unknown> };

/** How long a send waits on the mail server. nodemailer alone waits 2 minutes to connect, 30 seconds for the
 *  greeting and 10 minutes of silence, holding the page that sent it; a timeout written in SMTP_URL's query wins. */
export const MAIL_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

let testTransport: Transport | null = null;
let cached: { url: string; transport: Transport } | null = null;

/** Tests hand in a transport that records what it is given; null goes back to the real one. */
export function setMailTransportForTests(transport: Transport | null): void {
  testTransport = transport;
}

function transportFor(url: string): Transport {
  if (testTransport) return testTransport;
  if (cached?.url !== url) cached = { url, transport: nodemailer.createTransport({ url, ...MAIL_TIMEOUTS }) };
  return cached.transport;
}

/** Sends one plain-text message, or says why it did not. Never throws: the caller records the result. */
export async function sendMail(message: { to: string; subject: string; text: string }, env: MailEnv = process.env): Promise<SendResult> {
  let settings: MailSettings;
  try {
    settings = mailSettings(env);
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
  if (!settings.on) return { status: "off" };
  const to = message.to.trim();
  // the portal's one email rule (as the screens check it): one plain address, so no comma or bracket can add a recipient
  if (!z.email().safeParse(to).success) return { status: "failed", error: "that is not an email address" };
  if (/[\r\n]/.test(message.subject)) return { status: "failed", error: "a subject cannot hold a line break" };
  try {
    await transportFor(settings.url).sendMail({ from: settings.from, to, subject: message.subject, text: message.text });
    return { status: "sent", sentAt: nowIso() };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
