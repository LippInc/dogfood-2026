"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useSyncExternalStore } from "react";

// A clock that ticks every 30 s; the server has no clock (null), so the countdown
// appears after hydration and server and client HTML agree.
function subscribeClock(tick: () => void) {
  const t = setInterval(tick, 30_000);
  return () => clearInterval(t);
}
const clockNow = () => Math.floor(Date.now() / 30_000) * 30_000;

function left(ms: number): string {
  if (ms <= 0) return "closed";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return `${d} d ${h} h left`;
  if (h > 0) return `${h} h ${min} min left`;
  return `${min} min left`;
}

/**
 * A deadline in UTC (rendered on the server) plus the reader's local time and a
 * countdown (filled in after hydration, so server and client HTML agree).
 */
export function Deadline({ iso, utcLabel }: { iso: string; utcLabel: string }) {
  const now = useSyncExternalStore(subscribeClock, clockNow, () => null);
  const at = Date.parse(iso);
  // When the deadline passes with the page open, the page renders again from the server, so the
  // banner and the form lock too, not only this countdown (a tester found them still open).
  const router = useRouter();
  const closed = now !== null && at - now <= 0;
  const wasOpen = useRef<boolean | null>(null);
  useEffect(() => {
    if (now === null) return;
    if (wasOpen.current === true && closed) router.refresh();
    wasOpen.current = !closed;
  }, [closed, now, router]);
  const local =
    now === null
      ? null
      : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
  // Two lines of their own, each holding its room from the first paint (a no-break space keeps an empty line's
  // height), so nothing below moves when the browser fills them in; as one sentence they wrapped in a narrow column
  // and pushed the ballot down 36 px after load.
  return (
    <div>
      <p className="text-15 font-medium">{utcLabel}</p>
      <p className="mt-0.5 text-13 text-ink-3" suppressHydrationWarning>
        {local ? `${local} your time` : "\u00a0"}
      </p>
      <p className="text-13 text-ink-3 tnum" suppressHydrationWarning>
        {now === null ? "\u00a0" : left(at - now)}
      </p>
    </div>
  );
}
