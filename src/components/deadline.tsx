"use client";

import { useSyncExternalStore } from "react";

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
  const local =
    now === null
      ? null
      : new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
  return (
    <div>
      <p className="text-15 font-medium">{utcLabel}</p>
      <p className="mt-0.5 text-13 text-ink-3" suppressHydrationWarning>
        {local ? `${local} your time · ${left(at - now!)}` : " "}
      </p>
    </div>
  );
}
