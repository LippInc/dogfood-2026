import { Face } from "@/components/face";

/**
 * An invitation as a ticket: the page's content on the left, a stub on the right
 * behind a perforated line, with a face drawn from what the invitation is for and
 * one number worth seeing (members so far, tracks to judge). On phones the stub
 * drops below. Server-rendered; the notches are CSS.
 */
export function Ticket({ faceId, stubLabel, stubValue, children }: { faceId: string; stubLabel: string; stubValue: string; children: React.ReactNode }) {
  return (
    <div className="ticket grid rounded-sm border border-rule bg-surface md:grid-cols-[minmax(0,1fr)_184px]">
      <div className="min-w-0 p-6 sm:p-8">{children}</div>
      <div className="ticket-stub relative flex flex-col gap-3 border-t border-dashed border-edge p-6 max-md:flex-row max-md:items-center md:border-t-0 md:border-l">
        <div className="w-28 shrink-0 overflow-hidden rounded-xs border border-rule md:w-full" aria-hidden="true">
          <Face id={faceId} cols={32} rows={18} />
        </div>
        <div>
          <p className="label-mono text-ink-3">{stubLabel}</p>
          <p className="mt-1 font-display text-24 tnum">{stubValue}</p>
        </div>
      </div>
    </div>
  );
}
