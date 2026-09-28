"use client";

import { useEffect } from "react";

/**
 * Marks the index row of the section being read (aria-current="location"), so the
 * sticky FIG. 01 says where you are on a long page. Renders nothing; without script
 * the index still works as plain links.
 */
export function SectionMarker({ nav }: { nav: string }) {
  useEffect(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>(`#${nav} a[href^="#"]`)];
    const sections = links.map((a) => document.getElementById(a.hash.slice(1))).filter((s): s is HTMLElement => s !== null);
    let frame = 0;
    const mark = () => {
      frame = 0;
      // the last section whose top has passed a line a third of the way down the screen
      const line = window.innerHeight / 3;
      let current: HTMLElement | undefined;
      for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
      for (const a of links) {
        if (current && a.hash === `#${current.id}`) a.setAttribute("aria-current", "location");
        else a.removeAttribute("aria-current");
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(mark);
    };
    mark();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [nav]);
  return null;
}
