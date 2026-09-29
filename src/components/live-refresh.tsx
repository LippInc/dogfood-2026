"use client";

import { Pause, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";

// The organizer's pages stay live: every few seconds, while the tab is visible,
// the server components render again with fresh numbers. Client state (an open
// decision, a half-typed reason) survives the refresh. The indicator is also the
// pause switch (WCAG 2.2.2): a paused tab stays paused on every organizer page of
// this tab until it is resumed, and resuming fetches fresh numbers at once.
// The choice lives in sessionStorage, which the server cannot read: the server draws
// a neutral switch of the same size (no word, grey dot) and the client fills in Live
// or Paused, so a paused tab never shows "Live" for a moment on each page load.

const PAUSE_KEY = "live-refresh-paused";
const pauseListeners = new Set<() => void>();

function subscribeVisibility(change: () => void) {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
}

function readPaused(): boolean {
  try {
    return sessionStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribePaused(change: () => void) {
  pauseListeners.add(change);
  return () => pauseListeners.delete(change);
}

let pausedFallback = false; // when storage is blocked, the choice lasts for this page
function setPaused(paused: boolean) {
  pausedFallback = paused;
  try {
    if (paused) sessionStorage.setItem(PAUSE_KEY, "1");
    else sessionStorage.removeItem(PAUSE_KEY);
  } catch {
    // storage blocked: pausedFallback carries it
  }
  pauseListeners.forEach((l) => l());
}

const clock = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function LiveRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const visible = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
  // null: not known yet (the server's render and hydration)
  const paused = useSyncExternalStore<boolean | null>(subscribePaused, () => readPaused() || pausedFallback, () => null);
  const known = paused !== null;
  const [at, setAt] = useState<string | null>(null);
  const running = visible && paused === false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      router.refresh();
      setAt(clock());
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds, running]);
  const toggle = () => {
    if (!known) return;
    if (paused) {
      router.refresh();
      setAt(clock());
    }
    setPaused(!paused);
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={!known ? "Live updates" : paused ? "Resume live updates" : "Pause live updates"}
      title={!known ? undefined : paused ? "Live updates paused. Resume to refresh this page again" : `Refreshes every ${seconds} s while this tab is open. Pause to keep the page still`}
      className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-transparent px-1.5 text-12 whitespace-nowrap text-ink-2 hover:border-rule hover:text-ink"
    >
      {!known ? (
        <span className="size-3.5" aria-hidden />
      ) : paused ? (
        <Play className="size-3.5" aria-hidden />
      ) : (
        <Pause className="size-3.5" aria-hidden />
      )}
      <span className={`size-1.5 rounded-full ${running ? "bg-ok" : known ? "bg-ink-3" : "bg-rule"}`} aria-hidden />
      {/* both words share one cell, so switching between them (or filling in the first) never changes the width */}
      <span className="hidden md:inline-grid" aria-hidden>
        <span className={`col-start-1 row-start-1 ${paused === false ? "" : "invisible"}`}>Live</span>
        <span className={`col-start-1 row-start-1 ${paused === true ? "" : "invisible"}`}>Paused</span>
      </span>
      {/* the clock's room is kept from the start, so the header does not shift when the first refresh writes the time */}
      <span className="hidden min-w-[10ch] tnum md:inline-block" aria-hidden>
        {at ? `· ${at}` : ""}
      </span>
    </button>
  );
}
