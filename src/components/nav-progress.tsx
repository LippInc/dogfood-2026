"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** How long a click must wait for its page before the line shows: a quick page lands without it ever flashing. */
const SHOW_AFTER_MS = 120;
/** A click whose page never lands (a link another script took over) does not leave the line up for good. */
const GIVE_UP_MS = 15_000;

/**
 * Whether a click on this link starts a page load in this tab that the portal draws: a same-origin page, opened
 * here, with no modifier key, other than the page already open (a #fragment on it only scrolls). Files and the API
 * (the CSV and JSON exports) download without leaving the page, so they never start the line.
 */
export function startsNavigation(
  click: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  link: { href: string; target: string; download: boolean },
  here: { href: string },
): boolean {
  if (click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if ((link.target && link.target !== "_self") || link.download) return false;
  let to: URL;
  let now: URL;
  try {
    now = new URL(here.href);
    to = new URL(link.href, now);
  } catch {
    return false;
  }
  if (to.origin !== now.origin) return false;
  if (to.pathname === "/api" || to.pathname.startsWith("/api/") || /\.[a-z0-9]+$/i.test(to.pathname)) return false;
  return to.pathname !== now.pathname || to.search !== now.search;
}

/**
 * The portal's loading state: a quiet accent line along the top of the window while a page the reader asked for is
 * drawn on the server. The pages render on request and some take a moment (the organizer's overview and results,
 * the judge console), and until the new page lands the old one stays on screen as it was, so nothing jumps: the
 * line sits over the page, fixed, and takes no room. It fills slowly towards the end, completes when the page lands
 * and fades; with reduced motion it only appears and goes.
 *
 * Why not loading.tsx: every page draws its own frame (the work and public shells are not layouts), so a route's
 * loading.tsx would replace the whole screen, top bar and tabs included, with a stand-in and then swap the real
 * page back in: exactly the jump this is here to avoid.
 */
export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const [phase, setPhase] = useState<"idle" | "loading" | "done">("idle");
  const pending = useRef(false);
  const timers = useRef<{ show?: ReturnType<typeof setTimeout>; giveUp?: ReturnType<typeof setTimeout>; fade?: ReturnType<typeof setTimeout> }>({});

  useEffect(() => {
    const t = timers.current;
    function onClick(e: MouseEvent) {
      const link = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      if (!startsNavigation(e, { href: link.href, target: link.target, download: link.hasAttribute("download") }, window.location)) return;
      pending.current = true;
      clearTimeout(t.show);
      clearTimeout(t.giveUp);
      clearTimeout(t.fade);
      t.show = setTimeout(() => pending.current && setPhase("loading"), SHOW_AFTER_MS);
      t.giveUp = setTimeout(() => {
        pending.current = false;
        setPhase("idle");
      }, GIVE_UP_MS);
    }
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      clearTimeout(t.show);
      clearTimeout(t.giveUp);
      clearTimeout(t.fade);
    };
  }, []);

  // The new page has landed (the router's address changed): complete the line and let it fade.
  useEffect(() => {
    const t = timers.current;
    if (!pending.current) return;
    pending.current = false;
    clearTimeout(t.show);
    clearTimeout(t.giveUp);
    setPhase((p) => (p === "loading" ? "done" : "idle"));
    t.fade = setTimeout(() => setPhase("idle"), 400);
  }, [pathname, search]);

  if (phase === "idle") return null;
  return <div role="progressbar" aria-label="Loading the page" aria-busy={phase === "loading"} data-phase={phase} data-stability-ignore="" className="nav-progress" />;
}
