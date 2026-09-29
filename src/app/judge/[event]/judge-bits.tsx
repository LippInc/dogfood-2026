"use client";

import { useState } from "react";
import { FieldError } from "@/components/field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { personHeaders } from "@/lib/session-watch";

// Small pieces the scores console and the pairwise Compare screen share.

const LETTERS_KEY = "judge-letter-keys";

// The single-key shortcut switch, kept in localStorage; if storage is blocked the
// choice lasts for this page only.
let lettersInMemory = true;
export const letters = {
  subscribe(change: () => void) {
    window.addEventListener("storage", change);
    window.addEventListener("judge:letters", change);
    return () => {
      window.removeEventListener("storage", change);
      window.removeEventListener("judge:letters", change);
    };
  },
  get(): boolean {
    try {
      const stored = localStorage.getItem(LETTERS_KEY);
      return stored === null ? lettersInMemory : stored !== "off";
    } catch {
      return lettersInMemory;
    }
  },
  set(on: boolean) {
    lettersInMemory = on;
    try {
      localStorage.setItem(LETTERS_KEY, on ? "on" : "off");
    } catch {
      /* storage blocked: memory only */
    }
    window.dispatchEvent(new Event("judge:letters"));
  },
};

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 40);
  } catch {
    return url.slice(0, 40);
  }
}

export function ProjectLink({ label, url }: { label: string; url: string | null }) {
  if (!url) return <span className="text-14 text-ink-3">No {label.toLowerCase()} submitted</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex h-9 max-w-full items-center gap-2 rounded-sm border border-edge px-3 text-14 hover:bg-raised"
    >
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-ink-2">{shortUrl(url)}</span>
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[2px] border border-edge px-1 font-mono text-12 text-ink">{children}</kbd>;
}

export function RecuseDialog({
  open,
  onOpenChange,
  teamName,
  assignmentId,
  onDone,
  pairwise = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  assignmentId: string;
  onDone: (message: string) => void;
  /** pairwise mode: the judge answers about the project instead of scoring it */
  pairwise?: boolean;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/judge/reviews/${assignmentId}/recuse`, {
        method: "POST",
        headers: { "content-type": "application/json", ...personHeaders() },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.details?.reason?.[0] ?? body.message ?? "Not recorded.");
        return;
      }
      setReason("");
      onDone(`You declared a conflict of interest, so this project left your ${pairwise ? "list" : "batch"}. The organizers can see why.`);
    } catch {
      setError("No connection. Nothing was recorded; try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Declare a conflict of interest</DialogTitle>
          <DialogDescription className="wrap-anywhere">
            If you know {teamName} or worked with them, you should not {pairwise ? "judge" : "score"} them. The project leaves your{" "}
            {pairwise ? "list, your answers about it no longer count" : "batch, your scores for it no longer count"}, and the organizers see your
            reason. This cannot be undone from here.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="recuse-reason" className="text-14 font-medium">
          Why, in a few words
        </label>
        <Textarea
          id="recuse-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "recuse-reason-error" : undefined}
        />
        <FieldError id="recuse-reason-error" message={error} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={busy || reason.trim().length < 3}>
            {busy ? "Recording…" : "Declare the conflict"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
