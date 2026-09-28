"use client";

import { useEffect, useState } from "react";

/** A time as HH:MM, or a placeholder of the same width until the browser has a clock. */
function Clock({ value }: { value: string | null }) {
  // Four tabular digits and a colon measure 4.5ch: "--:--" gets the room of "09:41", so the sentence never re-wraps when the time arrives.
  return <span className="inline-block min-w-[4.5ch] text-center tnum">{value ?? "--:--"}</span>;
}

/**
 * Date fields in the organizer's forms take UTC, but the browser shows them in its own
 * date format, which reads like local time. This line says what UTC is right now, and
 * the time where the reader is, so nobody sets a deadline an offset off.
 *
 * The server has no reader's clock, so it draws the whole sentence with placeholder times
 * and the browser fills them in: the line holds its room from the first paint and nothing
 * below it moves when the times arrive.
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
  const utc = now ? now.toISOString().slice(11, 16) : null;
  const local = now ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }) : null;
  return (
    <p className="text-13 text-ink-2">
      These times are UTC: it is <Clock value={utc} /> UTC now, <Clock value={local} /> where you are.
    </p>
  );
}
