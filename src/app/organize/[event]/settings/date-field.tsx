"use client";

import { useId, useState } from "react";
import { formatUtc } from "@/lib/format";

/**
 * A UTC date field that says back what it holds, written out ("1 Mar 2026, 18:00 UTC"). The browser
 * draws the field in its own local format (01/03/2026 06:00 pm), which reads as either day or month
 * first; the line under it settles which, and says what an empty field means.
 */
export function DateField({ label, name, value, empty, className }: { label: string; name: string; value: string; empty: string; className: string }) {
  const [typed, setTyped] = useState(value);
  const id = useId();
  // "2026-03-01T18:00" (or with seconds) is a UTC moment here
  const iso = typed ? `${typed}${typed.length === 16 ? ":00" : ""}Z` : "";
  return (
    <div className="flex flex-col gap-1 text-13 text-ink-2">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="datetime-local"
        name={name}
        defaultValue={value}
        onChange={(e) => setTyped(e.target.value)}
        aria-describedby={`${id}-said`}
        className={className}
      />
      <span id={`${id}-said`} className={`text-12 tnum ${typed ? "text-ink" : "text-ink-3"}`}>
        {typed ? formatUtc(iso) : empty}
      </span>
    </div>
  );
}
