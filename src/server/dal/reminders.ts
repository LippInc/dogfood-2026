import "server-only";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { appendAudit } from "../audit";
import { getDb, type Tx } from "../db/client";
import { outbox } from "../db/schema";
import { ConflictError, NotFoundError, RateLimitedError } from "../errors";
import { guardRead } from "../mutate";
import { reminderText, REMINDER_GAP_MS } from "@/lib/judge-reminder";
import { eventFacts, requireEvent } from "./events";
import { judgeRows, type JudgeRow } from "./judges";
import { emailIsOn, mailJudgeReminders, type MailReport } from "./mailing";
import { parse } from "./parse";

// Emailed reminders to judges. The Judges page has always made a reminder to copy; with SMTP_URL set the portal can
// also mail it, with the same words, through mailing.ts (each message recorded in the outbox, kind judge_reminder).
// A judge is mailed at most once an hour: the outbox itself says when each was last reminded, so the rule holds
// across restarts and for every organizer of the event.

/** Who to remind: one judge by id, or every judge who has saved nothing yet. */
export const ReminderInput = z.union([z.object({ judge: z.string().min(1) }), z.object({ notStarted: z.literal(true) })]);

/** The last reminder that may have reached each address in this event within the gap: (address -> when), from the outbox. */
function lastReminders(tx: Tx | ReturnType<typeof getDb>, eventId: string, addresses: string[], now: number): Map<string, number> {
  if (!addresses.length) return new Map();
  const since = new Date(now - REMINDER_GAP_MS).toISOString();
  const rows = tx
    .select({ to: outbox.toEmail, at: outbox.createdAt })
    .from(outbox)
    .where(
      and(
        eq(outbox.eventId, eventId),
        eq(outbox.kind, "judge_reminder"),
        // a message that did not go out (failed) does not count: the organizer may try again at once
        inArray(outbox.status, ["sending", "sent", "unknown"]),
        gt(outbox.createdAt, since),
        inArray(outbox.toEmail, addresses),
      ),
    )
    .all();
  const last = new Map<string, number>();
  for (const r of rows) last.set(r.to, Math.max(last.get(r.to) ?? 0, Date.parse(r.at)));
  return last;
}

/** Seconds until an address may be reminded again, from when it was last reminded. */
const waitFor = (at: number, now: number) => Math.max(1, Math.ceil((at + REMINDER_GAP_MS - now) / 1000));

export type ReminderReport = MailReport & { tooSoon: { judge: string; name: string; retryAfter: number }[] };

/**
 * Mail reminders: to one judge (with open reviews), or to every judge who has saved nothing yet. Each has the words
 * of its copy button. A judge the portal reminded within the hour is not mailed again: asked for alone, the answer
 * is 429 with Retry-After, recorded in the audit log as the portal's other limits are; in a batch they are left out
 * and named, and a batch where every judge is too soon is the same 429. Organizers only; with email off 409 email_off;
 * once results are published 409 results_published (scoring is over).
 */
export async function remindJudges(actor: Actor | null, eventIdOrSlug: string, input: unknown): Promise<ReminderReport> {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  // the organizer question first, audited on refusal, before anything else is said about the event
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) }, new Date(), "write");
  const ask = parse(ReminderInput, input);
  if (!emailIsOn()) throw new ConflictError("email_off", "This portal sends no email (SMTP_URL is not set): copy the reminder and send it yourself.");
  if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so scoring is over: there is nothing to remind a judge of.");
  const everyone = judgeRows(db, event.id);
  let chosen: JudgeRow[];
  if ("judge" in ask) {
    const one = everyone.find((j) => j.id === ask.judge);
    if (!one) throw new NotFoundError("Judge");
    if (one.pending === 0) throw new ConflictError("nothing_to_remind", `${one.name} has no open review to be reminded of.`);
    chosen = [one];
  } else {
    chosen = everyone.filter((j) => j.notStarted);
    if (!chosen.length) throw new ConflictError("nothing_to_remind", "Every judge with reviews assigned has saved something: nobody to remind.");
  }
  const now = Date.now();
  const last = lastReminders(db, event.id, chosen.map((j) => j.email), now);
  const tooSoon = chosen.filter((j) => last.has(j.email)).map((j) => ({ judge: j.id, name: j.name, retryAfter: waitFor(last.get(j.email)!, now) }));
  const go = chosen.filter((j) => !last.has(j.email));
  const refuse = (retryAfter: number, judges: string[]): never => {
    db.transaction((tx) =>
      appendAudit(tx, {
        actorUserId: actor!.userId,
        actorLabel: actor!.name,
        action: "ratelimit.refused",
        eventId: event.id,
        targetType: "limit",
        targetId: "judge reminder",
        after: { retryAfter, judges },
      }),
    );
    throw new RateLimitedError(retryAfter);
  };
  if (!go.length) refuse(Math.min(...tooSoon.map((t) => t.retryAfter)), tooSoon.map((t) => t.judge));
  const addresses = go.map((j) => j.email);
  let report: MailReport;
  try {
    report = await mailJudgeReminders(
      actor,
      event.id,
      go.map((j) => ({ to: j.email, text: (consoleUrl: string) => reminderText(j, event.name, consoleUrl) })),
      // asked again inside the write that records them, so two clicks at once mail a judge once
      (tx) => {
        const again = lastReminders(tx, event.id, addresses, Date.now());
        if (again.size) throw new RateLimitedError(Math.min(...[...again.values()].map((at) => waitFor(at, Date.now()))));
      },
    );
  } catch (err) {
    if (err instanceof RateLimitedError) refuse(err.retryAfter, go.map((j) => j.id));
    throw err;
  }
  return { ...report, tooSoon };
}
