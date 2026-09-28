"use client";

import { useLayoutEffect, useRef } from "react";

/**
 * Slides the children of a list to their new places after a re-render (FLIP: measure
 * first, measure last, invert, play). Children opt in with data-flip="<stable key>".
 * A child that was not there before fades in. Transform and opacity only, so nothing
 * reflows, and no motion at all when the reader asks for reduced motion.
 */
export function useFlip<T extends HTMLElement>(change: unknown) {
  const ref = useRef<T>(null);
  const last = useRef<Map<string, number> | null>(null);
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const child of list.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = child.dataset.flip!;
      // Where the row sits in the layout, not where a slide still running from the last change has drawn it:
      // measured mid-slide, the moved box read as a new move and restarted the slide on every re-render (the judge
      // console's ranking shook while a judge typed feedback, 2026-09-28).
      const top = child.offsetTop - (child.offsetParent === list ? 0 : list.offsetTop);
      next.set(key, top);
      const before = last.current?.get(key);
      if (reduce || !last.current || typeof child.animate !== "function") continue;
      if (before === undefined) {
        child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
      } else if (Math.abs(before - top) > 0.5) {
        child.animate([{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }], {
          duration: 320,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        });
      }
    }
    last.current = next;
  }, [change]);
  return ref;
}
