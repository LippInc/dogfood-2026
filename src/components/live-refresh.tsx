"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

// The organizer's pages stay live: every few seconds, while the tab is visible,
// the server components render again with fresh numbers. Client state (an open
// decision, a half-typed reason) survives the refresh.

function subscribeVisibility(change: () => void) {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
}

export function LiveRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => {
      router.refresh();
      setAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }));
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds, visible]);
  return (
    <span className="hidden items-center gap-1.5 text-12 whitespace-nowrap text-ink-2 md:inline-flex" title={`Refreshes every ${seconds} s while this tab is open`}>
      <span className={`size-1.5 rounded-full ${visible ? "bg-ok" : "bg-ink-3"}`} aria-hidden />
      Live
      {/* the clock's room is kept from the start, so the header does not shift when the first refresh writes the time */}
      <span className="inline-block min-w-[10ch] tnum">{at ? `· ${at}` : ""}</span>
    </span>
  );
}
