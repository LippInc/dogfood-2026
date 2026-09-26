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

/** "evt_01" -> "EVT / 01" for the mono event label. */
export function idLabel(id: string): string {
  const [prefix, ...rest] = id.split("_");
  return rest.length ? `${prefix.toUpperCase()} / ${rest.join("_").toUpperCase()}` : id.toUpperCase();
}

export type EventTimes = {
  submissionsOpenAt: string | null;
  submissionsCloseAt: string;
  judgingCloseAt: string | null;
  resultsPublishedAt: string | null;
};

/** The event's phase in the organizers' dossier voice, for the status strip. */
export function eventPhase(e: EventTimes, now = new Date()): { key: string; parts: string[] } {
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
