"use client";

import { useAskedPath } from "@/components/status-sheet";

/** Record ids are drawn from an alphabet without 0, o, 1 and l (src/server/util.ts). */
const NEVER = ["0", "o", "1", "l"];

/**
 * When the id someone asked for holds a character no record id ever uses, say which:
 * it is almost always a misread from a printed certificate.
 */
export function LookAlikes() {
  const path = useAskedPath();
  let id = "";
  try {
    id = path ? decodeURIComponent(path.split("/").pop() ?? "").replace(/^rec_/, "") : "";
  } catch {
    return null; // a malformed escape in the address: nothing sensible to point at
  }
  const found = NEVER.filter((c) => id.includes(c));
  if (!found.length) return null;
  return (
    <p className="border-l-4 border-accent pl-3 text-ink">
      The id you asked for has{" "}
      {found.map((c, i) => (
        <span key={c}>
          {i ? (i === found.length - 1 ? " and " : ", ") : null}
          <span className="font-mono">{c}</span>
        </span>
      ))}{" "}
      in it, and record ids never do: it may be a misread from a printed copy.
    </p>
  );
}
