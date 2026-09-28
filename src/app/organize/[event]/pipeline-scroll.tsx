"use client";

import { useEffect } from "react";

/**
 * On phones the pipeline is one row that scrolls sideways, and the stations that
 * need the organizer (04, 06, 07 on the fixture) start off screen. After the first
 * paint this scrolls the row so the first station that waits on a decision, or else
 * the current one, sits at the left edge. Wider screens show all ten and never
 * overflow, so nothing moves there. Renders nothing.
 */
export function PipelineScroll({ listId }: { listId: string }) {
  useEffect(() => {
    const list = document.getElementById(listId);
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const target =
      list.querySelector<HTMLElement>("[data-station='open']") ??
      list.querySelector<HTMLElement>("[aria-current='step']");
    if (!target) return;
    const shift = target.getBoundingClientRect().left - list.getBoundingClientRect().left - 16;
    if (shift > 0) list.scrollLeft += shift;
  }, [listId]);
  return null;
}
