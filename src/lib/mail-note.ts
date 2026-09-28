import type { MailReport } from "@/server/dal";

// The sentence a screen shows after it made links: what was mailed, and what could not be. A plain
// function of the mailing step's answer, so the forms need no data access of their own.

/** One sentence for the screen that made the links: what was mailed, and what could not be. Null when nothing was mailed. */
export function mailNote(report: MailReport): string | null {
  if (!report.on || !report.mailed.length) return null;
  const sent = report.mailed.filter((m) => m.status === "sent");
  const failed = report.mailed.filter((m) => m.status === "failed");
  if (!failed.length) return sent.length === 1 ? `Mailed to ${sent[0]!.to}.` : `Mailed to all ${sent.length}.`;
  const why = failed[0]!.error ?? "the mail server refused it";
  if (!sent.length) return `Could not mail ${failed.length === 1 ? "it" : `any of the ${failed.length}`} (${why}).`;
  const who = failed.slice(0, 5).map((m) => m.to).join(", ") + (failed.length > 5 ? ` and ${failed.length - 5} more` : "");
  return `Mailed ${sent.length} of ${report.mailed.length}; could not mail ${who} (${why}).`;
}
