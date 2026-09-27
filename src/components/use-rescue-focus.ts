"use client";

import { useEffect, useRef } from "react";

/**
 * After `value` changes, if the focused element was removed by that change (focus fell
 * back to <body>, as when a submitted form gives way to its result), move focus to the
 * element `target` returns, so keyboard and screen-reader users keep their place and
 * hear what happened. It never takes focus from anything else.
 */
export function useRescueFocus(target: () => HTMLElement | null | undefined, value: unknown) {
  const seen = useRef(value);
  useEffect(() => {
    if (Object.is(seen.current, value)) return;
    seen.current = value;
    if (!document.activeElement || document.activeElement === document.body) target()?.focus();
  });
}
