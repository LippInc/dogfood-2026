"use client";

import { useEffect, useState } from "react";

export type ContentsEntry = { id: string; num: string; title: string; holds: string };

/**
 * The settings sheet's contents: one numbered line per section with what it holds now (from the
 * data layer, server-rendered). Once the page runs, the wide rail also marks the section being read.
 */
export function SettingsContents({ entries, variant }: { entries: ContentsEntry[]; variant: "rail" | "index" }) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const pairs = entries.flatMap((e) => {
      const s = document.getElementById(`${e.id}-title`)?.closest("section");
      return s ? [[e.id, s] as const] : [];
    });
    if (!pairs.length) return;
    if (variant !== "rail") return;
    // the section being read: the last one whose top has passed a third of the window; the last one at the page's end
    let frame = 0;
    const pick = () => {
      frame = 0;
      const line = window.innerHeight / 3;
      let at = pairs[0][0];
      for (const [id, s] of pairs) if (s.getBoundingClientRect().top <= line) at = id;
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) at = pairs[pairs.length - 1][0];
      setCurrent(at);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(pick);
    };
    pick();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [entries, variant]);

  const state = (id: string, holds: string) =>
    <span className="text-12 text-ink-3 tnum">{holds}</span>;

  if (variant === "index") {
    return (
      <nav aria-label="Settings sections" className="lg:hidden">
        <ol className="grid grid-cols-2 gap-x-4 border-t-2 border-ink pt-2">
          {entries.map(({ id, num, title, holds }) => (
            <li key={id} className="min-w-0 border-b border-rule">
              <a href={`#${id}-title`} className="flex min-h-10 items-baseline gap-2 py-2.5 text-13 text-ink-2 hover:text-ink">
                <span className="font-mono text-12 text-ink-3">{num}</span>
                <span className="min-w-0 grow">{title}</span>
                {state(id, holds)}
              </a>
            </li>
          ))}
        </ol>
      </nav>
    );
  }
  return (
    <nav aria-label="Settings sections" className="max-lg:hidden">
      <ol className="sticky top-6 flex flex-col border-l-2 border-ink">
        {entries.map(({ id, num, title, holds }) => {
          const here = current === id;
          return (
            <li key={id} className="-ml-0.5">
              <a
                href={`#${id}-title`}
                aria-current={here ? "location" : undefined}
                className="flex items-baseline gap-2.5 border-l-2 border-transparent py-1.5 pl-3 text-13 text-ink-2 hover:text-ink aria-[current]:border-accent aria-[current]:font-medium aria-[current]:text-ink"
              >
                <span className={`font-mono text-12 ${here ? "text-accent-ink" : "text-ink-3"}`}>{num}</span>
                <span className="min-w-0 grow">{title}</span>
                {state(id, holds)}
              </a>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
