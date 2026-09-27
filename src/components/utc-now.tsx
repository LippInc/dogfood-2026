"use client";

import { useEffect, useState } from "react";

/**
 * Date fields in the organizer's forms take UTC, but the browser shows them in its own
 * date format, which reads like local time. This line says what UTC is right now, and
 * the time where the reader is, so nobody sets a deadline an offset off.
 */
export function UtcNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
  if (!now) return null;
  const utc = now.toISOString().slice(11, 16);
  const local = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <p className="text-13 text-ink-2">
      These times are UTC: it is {utc} UTC now{now.getTimezoneOffset() === 0 ? "" : `, ${local} where you are`}.
    </p>
  );
}
