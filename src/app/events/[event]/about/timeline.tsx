import { formatUtc, isPast } from "@/lib/format";
import type { PublicEvent } from "@/server/dal";

type Stage = { name: string; when: string; detail: string; state: "done" | "now" | "next"; at: number };

const STATE_WORD = { done: "Over", now: "Now", next: "To come" } as const;

/**
 * The event's stages in the order they happen, each with its dates and whether it is over,
 * happening now or still to come. Every date is the event's own; a date the organizers have
 * not set says so in words. The community vote appears only when the event has one.
 */
export function stagesOf(e: PublicEvent, now: number = Date.now()): Stage[] {
  const published = Boolean(e.resultsPublishedAt);
  const closed = isPast(e.submissionsCloseAt, now);
  const opened = !e.submissionsOpenAt || isPast(e.submissionsOpenAt, now);
  const closeAt = Date.parse(e.submissionsCloseAt);
  const judgingOver = published || Boolean(e.judgingCloseAt && isPast(e.judgingCloseAt, now));
  const middle: Stage[] = [
    {
      name: "Judging",
      when: e.judgingCloseAt
        ? `${isPast(e.judgingCloseAt, now) ? "Closed" : "Closes"} ${formatUtc(e.judgingCloseAt, { weekday: true })}`
        : published
          ? "Closed when the results went out"
          : "Closes when the organizers call it",
      detail: "Starts when submissions close",
      state: judgingOver ? "done" : closed ? "now" : "next",
      at: closeAt,
    },
  ];
  if (e.votingOpenAt || e.votingCloseAt) {
    const open = !e.votingOpenAt || isPast(e.votingOpenAt, now);
    const over = Boolean(e.votingCloseAt && isPast(e.votingCloseAt, now));
    middle.push({
      name: "Community vote",
      when: e.votingCloseAt ? `${over ? "Closed" : "Closes"} ${formatUtc(e.votingCloseAt, { weekday: true })}` : "Closes when the organizers call it",
      detail: e.votingOpenAt ? `Opens ${formatUtc(e.votingOpenAt, { weekday: true })}` : "Open from the start",
      state: over ? "done" : open ? "now" : "next",
      at: e.votingOpenAt ? Date.parse(e.votingOpenAt) : closeAt,
    });
  }
  middle.sort((a, b) => a.at - b.at);
  return [
    {
      name: "Submissions",
      when: `${closed ? "Closed" : "Close"} ${formatUtc(e.submissionsCloseAt, { weekday: true })}`,
      detail: e.submissionsOpenAt ? `Open ${formatUtc(e.submissionsOpenAt, { weekday: true })}` : "Open from the start",
      state: closed ? "done" : opened ? "now" : "next",
      at: e.submissionsOpenAt ? Date.parse(e.submissionsOpenAt) : 0,
    },
    ...middle,
    {
      name: "Results",
      when: e.resultsPublishedAt ? `Published ${formatUtc(e.resultsPublishedAt, { weekday: true })}` : "Not yet published",
      detail: "Every score with its working, track by track",
      state: published ? "done" : "next",
      at: Number.MAX_SAFE_INTEGER,
    },
  ];
}

/** FIG. 01: the stages as one line, drawn like the team's own stepper: ink when over, pink now, a hairline to come. */
export function Timeline({ stages }: { stages: Stage[] }) {
  const cols = stages.length === 4 ? "lg:grid-cols-4" : "lg:grid-cols-3";
  return (
    <ol className={`mt-8 flex flex-col lg:grid ${cols}`}>
      {stages.map((s, i) => (
        <li key={s.name} className="relative pb-8 pl-8 lg:pb-0 lg:pl-0 lg:pr-8 lg:pt-8" aria-current={s.state === "now" ? "step" : undefined}>
          <span
            aria-hidden
            className={`absolute top-0 bottom-0 left-[5px] w-[3px] lg:left-0 lg:right-0 lg:bottom-auto lg:h-[3px] lg:w-auto ${
              s.state === "done" ? "bg-ink" : s.state === "now" ? "bg-accent" : "bg-rule"
            }`}
          />
          <span
            aria-hidden
            className={`absolute top-0 left-0 size-[13px] lg:-top-[5px] ${
              s.state === "done" ? "bg-ink" : s.state === "now" ? "bg-accent" : "border-2 border-edge bg-bg"
            }`}
          />
          <p className="-mt-1 flex items-baseline gap-3 lg:mt-0">
            <span className="font-mono text-12 text-ink-3">{String(i + 1).padStart(2, "0")}</span>
            <span className={`label-mono ${s.state === "now" ? "text-accent-ink" : "text-ink-3"}`}>{STATE_WORD[s.state]}</span>
          </p>
          <h3 className="mt-2 text-20 font-semibold">{s.name}</h3>
          <p className={`mt-2 text-15 tnum ${s.state === "next" ? "text-ink-2" : "font-medium"}`}>{s.when}</p>
          <p className="mt-1 text-13 text-ink-3 tnum">{s.detail}</p>
        </li>
      ))}
    </ol>
  );
}
