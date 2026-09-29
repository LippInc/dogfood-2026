import { plural } from "./format";

/**
 * The words of a reminder to one judge: the Judges page's "Copy reminder" gives them, and with SMTP_URL set the
 * portal mails the same words ("Email reminder"). A judge who has saved nothing is told none is started; one who has
 * is told how many are still open. The console address is the portal's own (publicUrl()), never the request's.
 */
export function reminderText(j: { name: string; assigned: number; pending: number; notStarted: boolean }, eventName: string, consoleUrl: string): string {
  return j.notStarted
    ? `Hi ${j.name}, your ${plural(j.assigned, "review")} for ${eventName} ${j.assigned === 1 ? "is" : "are"} waiting for you, and none is started yet. Your console: ${consoleUrl}`
    : `Hi ${j.name}, ${j.pending} of your ${plural(j.assigned, "review")} for ${eventName} ${j.pending === 1 ? "is" : "are"} still open. Your console: ${consoleUrl}`;
}

/** How long after one reminder the portal mails the same judge another: an hour. */
export const REMINDER_GAP_MS = 60 * 60 * 1000;
