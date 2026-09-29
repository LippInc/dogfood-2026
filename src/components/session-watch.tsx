"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { markStale, readAnnouncement, SESSION_CHANNEL, setPagePerson, staleness, type PagePerson, type Staleness } from "@/lib/session-watch";

/** How often a tab coming back into view may ask who the session is (focus and visibilitychange both fire). */
const CHECK_GAP = 1500;

/**
 * Tells a page when the browser's sign-in stops being the person it was drawn for (see src/lib/session-watch.ts):
 * another tab signed in as someone else or signed out, or the session ended. For a signed-in page it opens a dialog
 * that cannot be dismissed, over a page that takes no more input, so nothing more is saved as the wrong person;
 * Reload draws the page for whoever is signed in now. A visitor's page only offers the reload.
 */
export function SessionWatch({ person }: { person: PagePerson }) {
  // what this tab learned, and for which page person (a new person on the page makes an old notice moot)
  const [learned, setLearned] = useState<{ page: string | null; change: Staleness }>({ page: null, change: { kind: "same" } });
  const lastCheck = useRef(0);
  const id = person?.id ?? null;
  const name = person?.name ?? null;

  const learn = useCallback(
    (now: PagePerson) => {
      const s = staleness(id && name ? { id, name } : null, now);
      if (s.kind === "same") return;
      if (id) markStale();
      setLearned({ page: id, change: s });
    },
    [id, name],
  );

  // This tab now shows its person: say so to the other tabs (a sign-in or sign-out lands here as a fresh page).
  useEffect(() => {
    const me: PagePerson = id && name ? { id, name } : null;
    setPagePerson(me);
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    channel.onmessage = (e: MessageEvent) => {
      const said = readAnnouncement(e.data);
      if (said !== undefined) learn(said);
    };
    channel.postMessage({ type: "person", person: me });
    return () => channel.close();
  }, [id, name, learn]);

  // Back in view: ask who the session is now (a session that expired or a password reset ended announces nothing).
  useEffect(() => {
    const check = async () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck.current < CHECK_GAP) return;
      lastCheck.current = Date.now();
      try {
        const res = await fetch("/api/auth/session", { cache: "no-store", headers: { accept: "application/json" } });
        if (!res.ok) return;
        const body = (await res.json()) as { person?: unknown };
        const now = readAnnouncement({ type: "person", person: body.person ?? null });
        if (now !== undefined) learn(now);
      } catch {
        // offline: the next return to the tab asks again
      }
    };
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [learn]);

  const change = learned.page === id ? learned.change : { kind: "same" as const };
  if (change.kind === "same") return null;
  const signedIn = Boolean(id);
  const title = !signedIn ? "You signed in in another tab" : change.kind === "signed-out" ? "You are signed out" : "Signed in as someone else";
  const said = !signedIn
    ? `This page was opened before you signed in. Reload it to continue as ${change.kind === "changed" ? change.to : "yourself"}.`
    : change.kind === "signed-out"
      ? `This tab was opened as ${name}. You were signed out in another tab, or the session ended, so this tab saves nothing more.`
      : `This tab was opened as ${name}. You are now signed in as ${change.to} in another tab, so this tab saves nothing more. Reload to continue as ${change.to}.`;
  return (
    <Dialog open onOpenChange={(open) => (!open && !signedIn ? setLearned({ page: id, change: { kind: "same" } }) : undefined)}>
      <DialogContent
        showCloseButton={!signedIn}
        onEscapeKeyDown={signedIn ? (e) => e.preventDefault() : undefined}
        onPointerDownOutside={signedIn ? (e) => e.preventDefault() : undefined}
        onInteractOutside={signedIn ? (e) => e.preventDefault() : undefined}
        data-testid="session-changed"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{said}</DialogDescription>
        </DialogHeader>
        {signedIn ? (
          <p className="text-14 text-ink-2">One browser holds one sign-in at a time. To be two people at once, use a private window or another browser.</p>
        ) : null}
        <DialogFooter>
          <Button autoFocus onClick={() => window.location.reload()}>
            {change.kind === "changed" ? `Reload as ${change.to}` : "Reload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
