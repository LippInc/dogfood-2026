import type { MailReport } from "@/server/dal";

// The sentence a screen shows after it made links: what was mailed, what could not be, and what may have
// arrived. A plain function of the mailing step's answer, so the forms need no data access of their own.

const list = (to: string[]) => to.slice(0, 5).join(", ") + (to.length > 5 ? ` and ${to.length - 5} more` : "");

/** One note for the screen that made the links. Null when nothing was mailed. Failures are grouped by their
 *  reason, so a mixed batch says why each address failed; a message whose outcome is unknown (the connection
 *  broke after it was handed over) is said apart, with the advice that fits it: a new link would replace one
 *  the person may already have. */
export function mailNote(report: MailReport): string | null {
  if (!report.on || !report.mailed.length) return null;
  const total = report.mailed.length;
  const sent = report.mailed.filter((m) => m.status === "sent");
  const failed = report.mailed.filter((m) => m.status === "failed");
  const unknown = report.mailed.filter((m) => m.status === "unknown");
  const pending = report.mailed.filter((m) => m.status === "pending");
  if (pending.length) {
    const head = pending.length === total ? (total === 1 ? "Mailing it now" : `Mailing all ${total} now`) : `Mailing ${pending.length} of ${total} now`;
    return `${head}: the mail server is slow to answer, so the links are here first. The outbox shows each result as it comes.`;
  }
  if (!failed.length && !unknown.length) return sent.length === 1 ? `Mailed to ${sent[0]!.to}.` : `Mailed to all ${sent.length}.`;
  const parts: string[] = [];
  if (sent.length) parts.push(`Mailed ${sent.length} of ${total}.`);
  if (failed.length) {
    const byReason = new Map<string, string[]>();
    for (const m of failed) {
      const why = m.error ?? "the mail server refused it";
      byReason.set(why, [...(byReason.get(why) ?? []), m.to]);
    }
    const groups = [...byReason].map(([why, to]) => `${list(to)} (${why})`);
    parts.push(
      total === 1 || (failed.length === total && byReason.size === 1)
        ? `Could not mail ${failed.length === 1 ? "it" : `any of the ${failed.length}`} (${[...byReason.keys()][0]}).`
        : `Could not mail ${groups.join("; ")}.`,
    );
  }
  if (unknown.length) {
    parts.push(
      `${unknown.length === 1 ? (total === 1 ? "It" : unknown[0]!.to) : list(unknown.map((m) => m.to))} may have arrived: the connection to the mail server broke after the message was handed over. Ask before making a new link, which would replace the one they may have.`,
    );
  }
  return parts.join(" ");
}
