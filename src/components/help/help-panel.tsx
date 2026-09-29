"use client";

import { ArrowRight, CircleHelp, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogSheet, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ask, audienceLabel, resolveHref, suggestionsFor, type HelpAnswer, type HelpEntry, type HelpViewer } from "@/lib/help";
import { HELP_KEY_STORAGE, helpKeyWanted } from "@/lib/help/key";

/** The reader's choice for the ? key, in this browser only; on unless they turned it off. */
let keyInMemory = true;
const helpKey = {
  subscribe(change: () => void) {
    window.addEventListener("storage", change);
    window.addEventListener("help:key", change);
    return () => {
      window.removeEventListener("storage", change);
      window.removeEventListener("help:key", change);
    };
  },
  get(): boolean {
    try {
      const stored = localStorage.getItem(HELP_KEY_STORAGE);
      return stored === null ? keyInMemory : stored !== "off";
    } catch {
      return keyInMemory;
    }
  },
  set(on: boolean) {
    keyInMemory = on;
    try {
      localStorage.setItem(HELP_KEY_STORAGE, on ? "on" : "off");
    } catch {
      /* storage blocked: memory only */
    }
    window.dispatchEvent(new Event("help:key"));
  },
};

type Turn = { id: number; answer: HelpAnswer };

const KIND_LABEL: Record<HelpEntry["kind"], string> = { page: "Page", task: "How to", concept: "Idea" };

/**
 * The Help button for the top bar, and the panel it opens: a question box, suggested questions for the person's
 * role, and answers from the portal's own guide (src/lib/help), matched in the browser. Nothing is sent anywhere
 * and nothing is kept: the thread lasts while the page is open, closed and opened again included. `questionKey`
 * binds the ? key to it (off on the judge pages, whose own ? lists their keys).
 */
export function HelpButton({ viewer, variant, questionKey = true }: { viewer: HelpViewer; variant: "public" | "work"; questionKey?: boolean }) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const keyOn = useSyncExternalStore(helpKey.subscribe, helpKey.get, () => true);

  // the sheet renders inside the page's own frame, so it wears the tokens of the side it opened on
  const show = () => {
    setContainer((trigger.current?.closest(".public, .work") as HTMLElement | null) ?? null);
    setOpen(true);
  };

  useEffect(() => {
    if (!questionKey) return;
    function onKey(e: KeyboardEvent) {
      if (!helpKeyWanted(e, document, helpKey.get())) return;
      e.preventDefault();
      setContainer((trigger.current?.closest(".public, .work") as HTMLElement | null) ?? null);
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [questionKey]);

  // The work side's bar is full on busy pages (the overview's tools), so there Help is an icon beside the mode
  // toggle's, as quiet as it; the public side has room for the word from lg up. Either way the size is fixed on
  // the server, so nothing moves when the page comes alive.
  const button =
    variant === "work"
      ? "inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-2 hover:bg-raised hover:text-ink"
      : "inline-flex size-9 shrink-0 items-center justify-center gap-1.5 rounded-sm border border-transparent text-14 text-ink-2 hover:border-rule hover:text-ink lg:w-auto lg:px-3";

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? show() : setOpen(false))}>
      <DialogTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-keyshortcuts={questionKey && keyOn ? "?" : undefined}
          title={questionKey && keyOn ? "Help (press ?)" : "Help"}
          className={button}
        >
          <CircleHelp className="size-4 shrink-0" aria-hidden />
          <span className={variant === "public" ? "max-lg:sr-only" : "sr-only"}>Help</span>
        </button>
      </DialogTrigger>
      <HelpSheet
        viewer={viewer}
        container={container}
        questionKey={questionKey}
        keyOn={keyOn}
        turns={turns}
        setTurns={setTurns}
        onLeave={() => setOpen(false)}
      />
    </Dialog>
  );
}

function HelpSheet({
  viewer,
  container,
  questionKey,
  keyOn,
  turns,
  setTurns,
  onLeave,
}: {
  viewer: HelpViewer;
  container: HTMLElement | null;
  questionKey: boolean;
  keyOn: boolean;
  turns: Turn[];
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  onLeave: () => void;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const thread = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const suggestions = suggestionsFor(viewer);

  const put = (question: string) => {
    const q = question.trim();
    if (!q) return;
    setTurns((t) => [...t, { id: (t.at(-1)?.id ?? 0) + 1, answer: ask(q, viewer) }]);
    setDraft("");
  };

  // the newest answer comes into view at the top of the thread (a response to the reader's own Enter or click)
  const last = turns.at(-1)?.id;
  useEffect(() => {
    if (last === undefined) return;
    const el = thread.current?.querySelector<HTMLElement>(`[data-turn="${last}"]`);
    if (el && thread.current) thread.current.scrollTop = Math.max(0, el.offsetTop - 20);
  }, [last]);

  return (
    <DialogSheet
      container={container}
      onOpenAutoFocus={(e) => {
        // on a phone the keyboard would cover the suggestions: focus stays on the sheet's first control there
        if (window.matchMedia("(min-width: 640px)").matches) {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      <header className="flex items-start gap-3 border-b border-rule px-5 pt-4 pb-3.5">
        <div className="min-w-0 flex-1">
          <DialogTitle className="flex items-center gap-2 text-17 font-semibold">
            <CircleHelp className="size-4 text-ink-3" aria-hidden />
            Help
          </DialogTitle>
          <DialogDescription className="mt-1 text-13 text-ink-2">
            Searches the portal&rsquo;s own guide, in your browser; nothing you type is sent. Not an AI model.
          </DialogDescription>
        </div>
        <DialogClose className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-3 hover:bg-raised hover:text-ink">
          <XIcon className="size-4" aria-hidden />
          <span className="sr-only">Close Help</span>
        </DialogClose>
      </header>

      <div ref={thread} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-5 pb-6">
        {turns.length === 0 ? (
          <section aria-labelledby={`${inputId}-try`}>
            <h2 id={`${inputId}-try`} className="label-mono text-ink-3">
              {viewer.event ? `Try asking · ${viewer.event.name}` : "Try asking"}
            </h2>
            <ul className="mt-3 border-b border-rule">
              {suggestions.map((s) => (
                <li key={s} className="border-t border-rule">
                  <button
                    type="button"
                    onClick={() => {
                      put(s);
                      // the suggestions leave with the first question: focus goes to the box, not to the page behind
                      input.current?.focus();
                    }}
                    className="group flex min-h-11 w-full items-center gap-3 py-2 text-left text-15 text-ink hover:text-ink sm:min-h-10"
                  >
                    <span className="min-w-0 flex-1 underline decoration-transparent underline-offset-4 group-hover:decoration-edge">{s}</span>
                    <ArrowRight className="size-4 shrink-0 text-ink-3 group-hover:text-ink" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {/* each question and its answer is added here; a screen reader reads the new one out */}
        <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Answers" className="flex flex-col gap-8">
          {turns.map((t) => (
            <Exchange key={t.id} id={t.id} answer={t.answer} viewer={viewer} onLeave={onLeave} />
          ))}
        </div>
      </div>

      <footer className="border-t border-rule bg-surface px-5 pt-3.5 pb-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            put(draft);
            input.current?.focus();
          }}
          className="flex gap-2"
        >
          <label htmlFor={inputId} className="sr-only">
            Ask a question about the portal
          </label>
          <Input
            ref={input}
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about a page, a task or an idea"
            autoComplete="off"
            enterKeyHint="search"
            maxLength={200}
            className="h-10 flex-1 max-sm:h-11"
          />
          <Button type="submit" size="lg" className="max-sm:h-11">
            Ask
          </Button>
        </form>
        {questionKey ? (
          <label className="mt-3 flex items-center gap-2.5 text-13 text-ink-2 pointer-coarse:hidden">
            <input type="checkbox" checked={keyOn} onChange={(e) => helpKey.set(e.target.checked)} className="size-4 accent-[var(--primary)]" />
            <span>
              The <kbd className="rounded-[2px] border border-edge px-1 font-mono text-12">?</kbd> key opens Help (outside text boxes)
            </span>
          </label>
        ) : null}
      </footer>
    </DialogSheet>
  );
}

function Exchange({ id, answer, viewer, onLeave }: { id: number; answer: HelpAnswer; viewer: HelpViewer; onLeave: () => void }) {
  return (
    <article data-turn={id} aria-label={`Answer to: ${answer.question}`} className="flex flex-col gap-3">
      <p className="flex flex-col gap-1">
        <span className="label-mono text-ink-3">You asked</span>
        <span className="text-17 font-medium wrap-anywhere text-ink">{answer.question}</span>
      </p>
      {answer.matches.length ? (
        <ol className="flex flex-col">
          {answer.matches.map((m) => (
            <li key={m.entry.id} className="border-t border-rule py-3">
              <Match entry={m.entry} usable={m.usable} viewer={viewer} onLeave={onLeave} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="border-t border-rule pt-3">
          <p className="text-14 text-ink-2">Nothing in the guide matches that well enough to answer. These are the main places:</p>
          <ul className="mt-2 flex flex-col">
            {answer.places.map((e) => {
              const href = resolveHref(e, viewer.event);
              return (
                <li key={e.id} className="flex min-h-9 items-baseline justify-between gap-3 border-b border-rule py-1.5 last:border-b-0">
                  {href ? (
                    <Link href={href} onClick={onLeave} className="text-15 font-medium underline decoration-edge underline-offset-4 hover:decoration-ink">
                      {e.title}
                    </Link>
                  ) : (
                    <span className="text-15 font-medium">{e.title}</span>
                  )}
                  <span className="label-mono shrink-0 text-ink-3">{audienceLabel(e.who)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </article>
  );
}

function Match({ entry, usable, viewer, onLeave }: { entry: HelpEntry; usable: boolean; viewer: HelpViewer; onLeave: () => void }) {
  const href = resolveHref(entry, viewer.event);
  const who = audienceLabel(entry.who);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="label-mono text-ink-3">
        {KIND_LABEL[entry.kind]} · <span className={usable ? "" : "text-accent-ink"}>{usable ? who : `Only ${who.toLowerCase()}`}</span>
      </p>
      {href ? (
        <Link
          href={href}
          onClick={onLeave}
          className="group inline-flex items-baseline gap-1.5 self-start text-15 font-semibold underline decoration-edge underline-offset-4 hover:decoration-ink"
        >
          {entry.title}
          <ArrowRight className="size-3.5 shrink-0 translate-y-0.5 text-ink-3 group-hover:text-ink" aria-hidden />
        </Link>
      ) : (
        <p className="text-15 font-semibold">{entry.title}</p>
      )}
      <p className="text-14 text-ink-2">{entry.answer}</p>
      {href ? <p className="font-mono text-12 break-all text-ink-3">{href}</p> : null}
      {entry.doc ? (
        <p className="text-13 text-ink-2">
          Read more: <span className="font-mono text-12 text-ink">{entry.doc.file}</span>, &ldquo;{entry.doc.heading}&rdquo; (in the repository)
        </p>
      ) : null}
    </div>
  );
}
