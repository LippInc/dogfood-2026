import { Face } from "@/components/face";

/**
 * An invitation as a ticket: the page's content on the left, a stub on the right
 * behind a perforated line. The stub reads like one: what it admits at the top, a
 * face drawn from what the invitation is for, and one number worth seeing (seats
 * taken, projects to score, when the vote closes) at the foot, with an optional
 * drawing of that number (`stubArt`) and a small note under it. On phones the stub
 * drops below. Server-rendered; the notches are CSS.
 */
export function Ticket({
  faceId,
  stubHead,
  stubLabel,
  stubValue,
  stubNote,
  stubArt,
  children,
}: {
  faceId: string;
  stubHead?: string;
  stubLabel: string;
  stubValue: string;
  stubNote?: string;
  stubArt?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="ticket grid rounded-sm border border-rule bg-surface md:grid-cols-[minmax(0,1fr)_200px]">
      <div className="min-w-0 p-6 sm:p-8">{children}</div>
      <div className="ticket-stub relative flex gap-4 border-t border-dashed border-edge p-6 max-md:items-center md:flex-col md:justify-between md:border-t-0 md:border-l">
        <div className="flex shrink-0 flex-col gap-3 max-md:w-28">
          {stubHead ? <p className="label-mono text-accent-ink max-md:hidden">{stubHead}</p> : null}
          <div className="overflow-hidden rounded-xs border border-rule" aria-hidden="true">
            <Face id={faceId} cols={32} rows={18} />
          </div>
        </div>
        <div className="min-w-0">
          {stubHead ? <p className="label-mono text-accent-ink md:hidden">{stubHead}</p> : null}
          <p className="label-mono text-ink-3 max-md:mt-2">{stubLabel}</p>
          <p className="mt-1 font-display text-24 tnum">{stubValue}</p>
          {stubArt ? <div className="mt-3">{stubArt}</div> : null}
          {stubNote ? <p className="mt-2 text-13 text-ink-3">{stubNote}</p> : null}
        </div>
      </div>
    </div>
  );
}

/** The team's seats as pixels: one square per place, filled when taken. Decorative; the stub's number says it. */
export function Seats({ taken, of }: { taken: number; of: number }) {
  return (
    <div className="flex flex-wrap gap-1.5" aria-hidden="true">
      {Array.from({ length: of }, (_, i) => (
        <span key={i} className={`size-4 rounded-xs ${i < taken ? "bg-ink" : "border border-dashed border-edge"}`} />
      ))}
    </div>
  );
}

/**
 * A ticket's status line. Neutral (sunken) for a fact nobody can act on (closed, full, used);
 * `flag` only when the reader has something to do, since orange means "needs you".
 */
export function TicketNote({ flag = false, children }: { flag?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={
        flag
          ? "border-l-[3px] border-flag-bar bg-flag-bg px-4 py-3 text-15 text-flag"
          : "rounded-xs border border-rule bg-sunken px-4 py-3 text-15 text-ink-2"
      }
    >
      {children}
    </div>
  );
}
