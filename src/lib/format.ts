// Dates are written out in UTC ("1 Mar 2026, 18:00 UTC"), never as 01.03.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number) => String(n).padStart(2, "0");

/** "1 project", "2 projects": a count with its noun in the right number. */
export function plural(n: number, noun: string, many = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : many}`;
}

/**
 * How many community votes are in, in the organizer's words: "no votes are in yet", "1 vote is in",
 * "8 votes are in". A vote here is one ballot; never "people have voted", since ballots through the
 * open link cannot prove they come from different people.
 */
export function votesIn(n: number): string {
  return n === 0 ? "no votes are in yet" : n === 1 ? "1 vote is in" : `${n} votes are in`;
}

/** A closed vote's count, as a fact: "no votes", "1 vote", "8 votes". */
export function votesCount(n: number): string {
  return n === 0 ? "no votes" : plural(n, "vote");
}

/**
 * A form's result line: the message, then the field's detail when the message does not already say it
 * ("Check the highlighted fields. say why, in a few words"; a message that names the problem stands alone).
 */
export function withDetail(message: string, detail: string | null | undefined): string {
  if (!detail || message.toLowerCase().includes(detail.toLowerCase())) return message;
  return `${message} ${detail}`;
}

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

const FRACTIONS: [number, string][] = [
  [1 / 2, "½"],
  [1 / 3, "⅓"],
  [2 / 3, "⅔"],
  [1 / 4, "¼"],
  [3 / 4, "¾"],
  [1 / 5, "⅕"],
  [2 / 5, "⅖"],
  [3 / 5, "⅗"],
  [4 / 5, "⅘"],
  [1 / 6, "⅙"],
  [1 / 8, "⅛"],
];

/**
 * Each rubric criterion's share of the total weight, for display: fractions when every
 * share is a simple one (⅓ ⅓ ⅓), otherwise percentages for all of them (7 %, 13 %,
 * 20 %), so one rubric never mixes the two. The console and the About page both use it.
 */
export function weightShares(weights: number[]): string[] {
  const total = weights.reduce((s, w) => s + w, 0);
  const shares = weights.map((w) => (total > 0 ? w / total : 0));
  const glyphs = shares.map((s) => FRACTIONS.find(([v]) => Math.abs(v - s) < 1e-9)?.[1]);
  if (glyphs.every((g) => g !== undefined)) return glyphs as string[];
  return shares.map((s) => `${Math.round(s * 100)} %`);
}
