// Dates are written out in UTC ("1 Mar 2026, 18:00 UTC"), never as 01.03.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");

export function formatUtc(iso: string | null | undefined, opts: { weekday?: boolean; time?: boolean } = {}): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = `${opts.weekday ? `${DAYS[d.getUTCDay()]} ` : ""}${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  return opts.time === false ? day : `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "evt_01" -> "EVT / 01" for the mono event label; null for long generated ids, which read as noise. */
export function idLabel(id: string): string | null {
  const [prefix, ...rest] = id.split("_");
  const tail = rest.join("_");
  if (!tail || tail.length > 6) return null;
  return `${prefix.toUpperCase()} / ${tail.toUpperCase()}`;
}

export type EventTimes = {
  submissionsOpenAt: string | null;
  submissionsCloseAt: string;
  judgingCloseAt: string | null;
  resultsPublishedAt: string | null;
  votingOpenAt?: string | null;
  votingCloseAt?: string | null;
};

/** The event's phase in the organizers' dossier voice, for the status strip. */
export function eventPhase(e: EventTimes, now = new Date()): { key: string; parts: string[] } {
  const base = phaseOf(e, now);
  const t = now.getTime();
  if (e.votingOpenAt && e.votingCloseAt && t >= Date.parse(e.votingOpenAt) && t < Date.parse(e.votingCloseAt)) {
    return { key: base.key, parts: [...base.parts, `Voting open until ${formatUtc(e.votingCloseAt)}`] };
  }
  return base;
}

function phaseOf(e: EventTimes, now: Date): { key: string; parts: string[] } {
  const t = now.getTime();
  const close = formatUtc(e.submissionsCloseAt);
  if (e.resultsPublishedAt) {
    return { key: "published", parts: ["Results published", formatUtc(e.resultsPublishedAt)] };
  }
  if (e.submissionsOpenAt && t < Date.parse(e.submissionsOpenAt)) {
    return { key: "upcoming", parts: [`Submissions open ${formatUtc(e.submissionsOpenAt)}`, `Close ${close}`] };
  }
  if (t < Date.parse(e.submissionsCloseAt)) {
    return { key: "open", parts: ["Submissions open", `Close ${close}`] };
  }
  const judgingOver = e.judgingCloseAt && t >= Date.parse(e.judgingCloseAt);
  return {
    key: judgingOver ? "judged" : "judging",
    parts: [
      judgingOver ? "Judging closed" : "Judging in progress",
      `Submissions closed ${close}`,
      "Results not yet published",
    ],
  };
}

/** Whether a moment has passed (server pages ask this once per request). */
export function isPast(iso: string, now: number = Date.now()): boolean {
  return now >= Date.parse(iso);
}
