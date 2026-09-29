import "server-only";
import nodemailer from "nodemailer";
import { z } from "zod";
import { nowIso } from "./util";

// Email, off by default: with SMTP_URL unset the portal mails nothing and `docker compose up` stays
// offline, and each link is shown once on the screen that made it, as before. With SMTP_URL set
// (smtp://user:pass@host:587 or smtps://...) and MAIL_FROM, messages go out through that server.
// nodemailer builds the headers; the address must be one plain address and the subject cannot hold a
// line break, both refused before nodemailer sees them, so nothing a person typed can add a header
// or a recipient.

/** The settings mail reads (SMTP_URL, MAIL_FROM, PUBLIC_URL): process.env at run time, a plain object in tests. */
export type MailEnv = { SMTP_URL?: string; MAIL_FROM?: string; PUBLIC_URL?: string; [name: string]: string | undefined };

export type MailSettings = { on: false } | { on: true; url: string; from: string };

/** Null when the mail settings are usable (or email is off); otherwise a sentence naming the setting to fix. */
export function mailProblem(env: MailEnv = process.env): string | null {
  const url = env.SMTP_URL?.trim();
  if (!url) return null;
  if (!/^smtps?:\/\/[^/\s]/i.test(url)) return "SMTP_URL must start with smtp:// or smtps:// and name a mail server, as in smtp://user:password@mail.example.org:587";
  const from = env.MAIL_FROM?.trim();
  if (!from || !from.includes("@") || /[\r\n]/.test(from)) return "MAIL_FROM must be the address the portal mails from, as in portal@example.org, when SMTP_URL is set";
  // mailed links are built on the server from PUBLIC_URL; the screens use the browser's own address, so only mail would break
  if (!env.PUBLIC_URL?.trim()) return "PUBLIC_URL must be set when SMTP_URL is: mailed links start with it, and without it they would point at http://localhost:8080";
  return null;
}

/** The start of every mailed link: PUBLIC_URL without a trailing slash. */
export function mailBase(env: MailEnv = process.env): string {
  return (env.PUBLIC_URL?.trim() || "http://localhost:8080").replace(/\/+$/, "");
}

export function mailSettings(env: MailEnv = process.env): MailSettings {
  const problem = mailProblem(env);
  if (problem) throw new Error(problem);
  const url = env.SMTP_URL?.trim();
  return url ? { on: true, url, from: (env.MAIL_FROM ?? "").trim() } : { on: false };
}

/** failed: the message did not go out (never reached the server, or the server refused it); unknown: the connection
 *  broke after the message may have been handed over, so it may have arrived, and a new link would replace it. */
export type SendResult =
  | { status: "off" }
  | { status: "sent"; sentAt: string }
  | { status: "failed"; error: string; code?: string }
  | { status: "unknown"; error: string; code?: string };

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
    const code = (err as { code?: unknown }).code;
    const error = err instanceof Error ? err.message : String(err);
    return { status: outcomeOf(err), error, ...(typeof code === "string" ? { code } : {}) };
  }
}

/** Whether a send that threw certainly did not deliver: nodemailer does not say how far the conversation got,
 *  so a timeout or a dropped connection after the greeting counts as unknown (the server may have taken the
 *  message before the line went quiet), and everything that happens before any message can be handed over
 *  (no connection, no greeting, TLS or login refused) or that the server answered with a refusal counts as failed. */
export function outcomeOf(err: unknown): "failed" | "unknown" {
  const { code, responseCode, message } = err as { code?: unknown; responseCode?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (typeof responseCode === "number") return "failed"; // the server answered, and the answer was no
  if (code === "ETIMEDOUT") return /connection timeout|greeting never received/i.test(text) ? "failed" : "unknown";
  if (code === "ECONNECTION") return /closed unexpectedly/i.test(text) ? "unknown" : "failed";
  if (code === "ESOCKET") return /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|connect /i.test(text) ? "failed" : "unknown";
  return "failed";
}

/** nodemailer's codes for a server that cannot be used at all (unreachable, silent, refusing the login): the rest would fail too. */
const SERVER_DOWN = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ETLS", "EAUTH"]);

/** A batch starts no new send after this long, so the page that made the links answers before a proxy gives
 *  up on it (the sends already under way still finish, within the timeouts); the rest are shown to copy. */
export const MAIL_BATCH_MS = 20_000;

/**
 * Sends several messages, at most `concurrency` at a time, the results in the same order. Once the server
 * cannot be used at all, the messages not yet tried fail at once instead of each waiting out the timeouts;
 * past `budgetMs`, no new send starts.
 */
export async function sendMany(
  messages: { to: string; subject: string; text: string }[],
  env: MailEnv = process.env,
  concurrency = 4,
  budgetMs = MAIL_BATCH_MS,
): Promise<SendResult[]> {
  const started = Date.now();
  const results: SendResult[] = new Array(messages.length);
  let down: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < messages.length) {
      const i = next++;
      if (down) {
        results[i] = { status: "failed", error: `not tried: ${down}` };
        continue;
      }
      if (Date.now() - started > budgetMs) {
        results[i] = { status: "failed", error: "not tried: the batch ran out of time" };
        continue;
      }
      const result = await sendMail(messages[i]!, env);
      results[i] = result;
      if ((result.status === "failed" || result.status === "unknown") && result.code && SERVER_DOWN.has(result.code)) down = result.error;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, messages.length) }, worker));
  return results;
}
