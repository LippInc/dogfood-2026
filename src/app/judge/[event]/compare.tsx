"use client";

import { ArrowLeft, ArrowRight, Check, CircleAlert, Lock, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ProjectImage } from "@/components/project-cover";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { PairwiseProject, PairwiseState, PairwiseTrackState } from "@/server/dal";
import { Kbd, letters, paragraphs, ProjectLink } from "./judge-bits";

// The Compare screen: the judge console in pairwise mode (JUDGING.md "Pairwise mode").
// Two of the judge's own projects and one question, which is better. Each project is
// placed into the judge's list by binary search, so a batch of k needs about log2(k!)
// answers. The server asks the question and refuses an answer to any other one (409),
// so this page only shows what the server says, and reads the state again after each
// answer.

type Outcome = "left" | "right" | "tie";

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; text: string } | { kind: "error"; text: string };

export type Faces = Record<string, { small: ReactNode; large: ReactNode }>;

/** Roughly how many answers are left in a track: the current project's, then about log2(n + 1) for each one still to open. */
function questionsLeft(t: PairwiseTrackState): number {
  if (!t.current) return 0;
  let left = Math.max(1, t.current.ofAbout - t.current.question + 1);
  let n = t.list.length + 1;
  for (let k = t.placed + 1; k < t.total; k++, n++) left += Math.ceil(Math.log2(n + 1));
  return left;
}

export function CompareView({ initial, faces }: { initial: PairwiseState; faces: Faces }) {
  const [data, setData] = useState(initial);
  const [trackId, setTrackId] = useState<string | null>((initial.tracks.find((t) => t.current) ?? initial.tracks[0])?.trackId ?? null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [keysOpen, setKeysOpen] = useState(false);
  const lettersOn = useSyncExternalStore(letters.subscribe, letters.get, () => true);
  const track = data.tracks.find((t) => t.trackId === trackId) ?? data.tracks[0] ?? null;
  const slug = data.event.slug;
  const readOnly = data.readOnly;
  const busy = status.kind === "saving";

  const reload = useCallback(async () => {
    const res = await fetch(`/api/judge/${slug}/pairwise`, { cache: "no-store" });
    if (!res.ok) throw new Error(`state ${res.status}`);
    const next = (await res.json()) as PairwiseState;
    setData(next);
    return next;
  }, [slug]);

  const send = useCallback(
    async (path: "pick" | "undo", body: object, saved: (next: PairwiseState) => string) => {
      setStatus({ kind: "saving" });
      try {
        const res = await fetch(`/api/judge/${slug}/pairwise/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status >= 500) throw new Error(`server ${res.status}`);
        const answer = (await res.json().catch(() => ({}))) as { message?: string };
        if (!res.ok) {
          // Refused (the question changed in another tab, judging closed): show the server's current state and why.
          await reload().catch(() => null);
          setStatus({ kind: "error", text: answer.message ?? "That answer was not saved." });
          return;
        }
        setStatus({ kind: "saved", text: saved(await reload()) });
      } catch {
        setStatus({ kind: "error", text: "Not saved: the portal could not be reached. Try again." });
      }
    },
    [reload, slug],
  );

  const answer = useCallback(
    (outcome: Outcome) => {
      const q = track?.current;
      if (!track || !q || busy || readOnly) return;
      const placing = q.left.id === q.newId ? q.left : q.right;
      void send("pick", { trackId: track.trackId, left: q.left.id, right: q.right.id, outcome }, (next) => {
        const t = next.tracks.find((x) => x.trackId === track.trackId);
        if (!t) return "Saved.";
        if (t.current?.newId === placing.id) return `Saved. One more question about ${placing.title}.`;
        const at = t.list.findIndex((p) => p.id === placing.id) + 1;
        const where = at > 0 ? `${placing.title} is number ${at} of ${t.list.length} in your list.` : "";
        return t.current ? `Saved. ${where}` : `Saved. ${where} All ${t.total} placed.`;
      });
    },
    [busy, readOnly, send, track],
  );

  const undo = useCallback(() => {
    if (!track || busy || readOnly || track.answered === 0) return;
    void send("undo", { trackId: track.trackId }, () => "Your last answer was taken back; its question is here again.");
  }, [busy, readOnly, send, track]);

  useEffect(() => {
    const open = () => setKeysOpen(true);
    window.addEventListener("judge:keys", open);
    return () => window.removeEventListener("judge:keys", open);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (keysOpen || e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("textarea, input, select, [contenteditable='true']")) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        answer(e.key === "ArrowLeft" ? "left" : "right");
        return;
      }
      // Character keys can be turned off (WCAG 2.1.4).
      if (!lettersOn) return;
      const key = e.key.toLowerCase();
      if (key === "t") {
        e.preventDefault();
        answer("tie");
      } else if (key === "u") {
        e.preventDefault();
        undo();
      } else if (e.key === "?") {
        e.preventDefault();
        setKeysOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [answer, keysOpen, lettersOn, undo]);

  if (!track) {
    return (
      <div className="mx-auto max-w-[680px] px-6 py-16">
        <h1 className="font-serif text-38 font-semibold">Nothing to compare yet</h1>
        <p className="mt-3 text-15 text-ink-2">
          You have no projects in this event&rsquo;s tracks. The organizers assign them; this page fills in once they do.
        </p>
      </div>
    );
  }

  const q = track.current;
  const placing = q ? (q.left.id === q.newId ? q.left : q.right) : null;
  const against = q ? (q.left.id === q.newId ? q.right : q.left) : null;
  const left = questionsLeft(track);
  const canAnswer = !busy && !readOnly;
  const nextTrack = data.tracks.find((t) => t.trackId !== track.trackId && t.current);
  const pickTrack = (id: string) => {
    setTrackId(id);
    setStatus({ kind: "idle" });
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] lg:h-[calc(100dvh-3rem)] lg:grid-cols-[288px_minmax(0,1fr)]">
      {/* Rail: the judge's list so far, best first */}
      <aside aria-label="Your list" className="flex flex-col border-b border-rule bg-surface lg:min-h-0 lg:border-r lg:border-b-0">
        {data.tracks.length > 1 ? (
          <nav aria-label="Your tracks" className="border-b border-rule px-3 py-3">
            <ul className="flex flex-col gap-0.5">
              {data.tracks.map((t) => {
                const here = t.trackId === track.trackId;
                return (
                  <li key={t.trackId}>
                    <button
                      type="button"
                      onClick={() => pickTrack(t.trackId)}
                      aria-current={here ? "true" : undefined}
                      className={`flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-14 hover:bg-raised ${
                        here ? "bg-accent-tint font-medium text-accent-ink" : ""
                      }`}
                    >
                      <span className="truncate">{t.trackName}</span>
                      <span className="text-13 whitespace-nowrap text-ink-2 tnum">
                        {t.placed} of {t.total}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}
        <div className="border-b border-rule px-5 pt-6 pb-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-15 font-semibold">Your list</h2>
            <p className="text-13 whitespace-nowrap text-ink-2 tnum">
              {track.placed} of {track.total} placed
            </p>
          </div>
          <ol className="mt-3 flex gap-1" aria-hidden>
            {Array.from({ length: track.total }, (_, n) => (
              <li
                key={n}
                className={`h-1.5 flex-1 rounded-[1px] border ${
                  n < track.placed ? "border-ink bg-ink" : n === track.placed && q ? "border-accent bg-accent" : "border-edge bg-transparent"
                }`}
              />
            ))}
          </ol>
          <p className="mt-3 text-13 text-ink-2">
            {track.total === 0
              ? "No projects of yours in this track."
              : q
                ? `About ${left} more ${left === 1 ? "question" : "questions"} in ${track.trackName}.`
                : "All placed. You can take back your last answer until judging closes."}
          </p>
        </div>
        <ol aria-label={`Your list in ${track.trackName}, best first`} className="flex-1 overflow-y-auto max-lg:max-h-56">
          {track.list.map((p, n) => {
            const here = p.id === against?.id;
            return (
              <li
                key={p.id}
                aria-current={here ? "true" : undefined}
                className={`flex items-center gap-3 border-b border-rule px-5 py-3 ${here ? "lit border-l-[3px] border-l-accent bg-accent-tint pl-[17px]" : ""}`}
              >
                <span className="w-5 font-mono text-12 text-ink-3 tnum">{String(n + 1).padStart(2, "0")}</span>
                <span className="w-12 shrink-0">{faces[p.id]?.small}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-14 font-medium">{p.title}</span>
                  <span className="block truncate text-12 text-ink-2">{p.teamName}</span>
                </span>
                {here ? <span className="text-12 font-medium text-accent-ink">comparing</span> : null}
              </li>
            );
          })}
          {placing ? (
            <li className="flex items-center gap-3 border-b border-dashed border-edge px-5 py-3">
              <span className="w-5 font-mono text-12 text-ink-3">··</span>
              <span className="w-12 shrink-0 opacity-60">{faces[placing.id]?.small}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-14 text-ink-2">{placing.title}</span>
                <span className="block text-12 text-ink-3">being placed</span>
              </span>
            </li>
          ) : null}
        </ol>
        <div className="border-t border-rule px-5 py-4 text-13 text-ink-2 max-lg:hidden">
          <KeyHints lettersOn={lettersOn} />
        </div>
      </aside>

      {/* The question */}
      <section aria-labelledby="question" className="min-w-0 lg:overflow-y-auto">
        <div className="mx-auto max-w-[1080px] px-6 py-8 lg:px-10">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <p className="text-14 text-ink-2">
              {track.trackName}
              {q && placing ? (
                <>
                  {" · "}Placing <span className="font-semibold text-ink">{placing.title}</span>: question {q.question} of about {q.ofAbout}
                </>
              ) : null}
            </p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <StatusLine status={status} />
              <Button variant="outline" onClick={undo} disabled={!canAnswer || track.answered === 0}>
                <Undo2 aria-hidden />
                Undo last answer
                <kbd className="rounded-[2px] border border-current/40 px-1 font-mono text-12 max-lg:hidden">U</kbd>
              </Button>
            </div>
          </div>
          {readOnly ? (
            <p className="mt-4 flex items-start gap-2 border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-13 text-flag">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {readOnly}
            </p>
          ) : null}

          {q && placing && against ? (
            <>
              <h1 id="question" className="mt-6 font-serif text-38 font-semibold">
                Which is the better project?
              </h1>
              <p className="mt-2 max-w-[680px] text-15 text-ink-2">
                Weigh them as a whole, the way you would score them. When you truly cannot choose, call it too close; the new project then
                goes right below the other one.
              </p>
              <div className="mt-8 grid gap-6 md:grid-cols-2">
                {([q.left, q.right] as const).map((p, n) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    face={faces[p.id]?.large}
                    note={p.id === placing.id ? "Being placed" : `Number ${track.list.findIndex((x) => x.id === p.id) + 1} in your list`}
                    side={n === 0 ? "left" : "right"}
                    disabled={!canAnswer}
                    onPick={() => answer(n === 0 ? "left" : "right")}
                  />
                ))}
              </div>
              <div className="mt-6 flex justify-center max-lg:hidden">
                <Button size="lg" variant="outline" onClick={() => answer("tie")} disabled={!canAnswer}>
                  Too close to call
                  <kbd className="rounded-[2px] border border-current/40 px-1 font-mono text-12">T</kbd>
                </Button>
              </div>
            </>
          ) : (
            <div className="mt-6 max-w-[680px]">
              <h1 id="question" className="font-serif text-38 font-semibold">
                {track.total === 0 ? "Nothing to compare in this track" : `All ${track.total} placed`}
              </h1>
              <p className="mt-3 text-15 text-ink-2">
                {track.total === 0
                  ? "You have no projects in this track."
                  : `Your list for ${track.trackName}, best first. It counts as it stands when the organizers publish results.`}
              </p>
              <ol className="mt-6 border-t border-rule lg:hidden">
                {track.list.map((p, n) => (
                  <li key={p.id} className="flex items-center gap-3 border-b border-rule py-3">
                    <span className="w-5 font-mono text-12 text-ink-3 tnum">{String(n + 1).padStart(2, "0")}</span>
                    <span className="min-w-0 flex-1 truncate text-14 font-medium">{p.title}</span>
                  </li>
                ))}
              </ol>
              {nextTrack ? (
                <Button className="mt-6" size="lg" onClick={() => pickTrack(nextTrack.trackId)}>
                  Continue with {nextTrack.trackName}
                  <ArrowRight aria-hidden />
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </section>

      {/* Phone and tablet: the three answers stay in reach while the judge scrolls through both projects. */}
      {q ? (
        <div className="sticky bottom-0 z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-2 border-t border-rule bg-surface px-4 py-3 lg:hidden">
          <Button size="lg" onClick={() => answer("left")} disabled={!canAnswer} aria-label={`This one: ${q.left.title}`} className="min-w-0">
            <span className="truncate">{q.left.title}</span>
          </Button>
          <Button size="lg" variant="outline" onClick={() => answer("tie")} disabled={!canAnswer}>
            Too close
          </Button>
          <Button size="lg" onClick={() => answer("right")} disabled={!canAnswer} aria-label={`This one: ${q.right.title}`} className="min-w-0">
            <span className="truncate">{q.right.title}</span>
          </Button>
        </div>
      ) : null}

      <CompareKeys open={keysOpen} onOpenChange={setKeysOpen} lettersOn={lettersOn} />
    </div>
  );
}

function ProjectCard({
  project: p,
  face,
  note,
  side,
  disabled,
  onPick,
}: {
  project: PairwiseProject;
  face: ReactNode;
  note: string;
  side: "left" | "right";
  disabled: boolean;
  onPick: () => void;
}) {
  const body = paragraphs(p.description);
  return (
    <article aria-labelledby={`title-${p.id}`} className="flex min-w-0 flex-col rounded-sm border border-rule bg-surface">
      <div className="overflow-hidden rounded-t-sm border-b border-rule">
        {p.thumbnailUrl ? <ProjectImage src={p.thumbnailUrl} alt="" fallback={face} /> : face}
      </div>
      <div className="flex flex-1 flex-col px-5 pt-4 pb-5 wrap-anywhere">
        <p className="text-13 text-ink-2">{note}</p>
        <h2 id={`title-${p.id}`} className="mt-1 font-serif text-24 font-semibold">
          {p.title}
        </h2>
        {p.summary ? <p className="mt-1 font-serif text-17 text-ink-2">{p.summary}</p> : null}
        <p className="mt-3 text-14 text-ink-2">
          by <span className="font-semibold text-ink">{p.teamName}</span>
        </p>
        {p.tags.length ? (
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Tech tags">
            {p.tags.map((t) => (
              <li key={t} className="rounded-xs border border-rule px-1.5 py-0.5 font-mono text-12 text-ink-2">
                {t}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ProjectLink label="Repository" url={p.repoUrl} />
          <ProjectLink label="Demo video" url={p.videoUrl} />
          {p.liveUrl ? <ProjectLink label="Live demo" url={p.liveUrl} /> : null}
        </div>
        {body.length ? (
          <details className="mt-4 border-t border-rule pt-3">
            <summary className="cursor-pointer text-14 font-medium">Read the description</summary>
            {body.map((para, n) => (
              <p key={n} className="mt-3 font-serif text-15 leading-7">
                {para}
              </p>
            ))}
          </details>
        ) : null}
        <div className="mt-auto pt-5 max-lg:hidden">
          <Button size="xl" className="w-full" onClick={onPick} disabled={disabled} aria-label={`This one: ${p.title}`}>
            {side === "left" ? <ArrowLeft aria-hidden /> : null}
            This one
            {side === "right" ? <ArrowRight aria-hidden /> : null}
          </Button>
        </div>
      </div>
    </article>
  );
}

function StatusLine({ status }: { status: Status }) {
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-13 text-ink-2">
      {status.kind === "saving" ? (
        "Saving…"
      ) : status.kind === "saved" ? (
        <>
          <Check className="size-3.5 shrink-0 text-ok" aria-hidden />
          {status.text}
        </>
      ) : status.kind === "error" ? (
        <>
          <CircleAlert className="size-3.5 shrink-0 text-flag" aria-hidden />
          <span className="text-flag">{status.text}</span>
        </>
      ) : (
        ""
      )}
    </p>
  );
}

function KeyHints({ lettersOn }: { lettersOn: boolean }) {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-12 whitespace-nowrap">
      <li>
        <Kbd>←</Kbd> left is better
      </li>
      <li>
        <Kbd>→</Kbd> right is better
      </li>
      <li className={lettersOn ? "" : "opacity-50"}>
        <Kbd>T</Kbd> too close
      </li>
      <li className={lettersOn ? "" : "opacity-50"}>
        <Kbd>U</Kbd> undo
      </li>
      <li className={`col-span-2 ${lettersOn ? "" : "opacity-50"}`}>
        <Kbd>?</Kbd> all keys
      </li>
    </ul>
  );
}

function CompareKeys({ open, onOpenChange, lettersOn }: { open: boolean; onOpenChange: (open: boolean) => void; lettersOn: boolean }) {
  const rows: [React.ReactNode, string][] = [
    [<Kbd key="l">←</Kbd>, "The project on the left is better"],
    [<Kbd key="r">→</Kbd>, "The project on the right is better"],
    [<Kbd key="t">T</Kbd>, "Too close to call: the new project goes right below the other one"],
    [<Kbd key="u">U</Kbd>, "Take back your last answer in this track"],
    [<Kbd key="q">?</Kbd>, "This list"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keys</DialogTitle>
          <DialogDescription>Each answer saves at once. Holding a key down answers only once.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-14">
          {rows.map(([keys, what], n) => (
            <div key={n} className="contents">
              <dt className="whitespace-nowrap">{keys}</dt>
              <dd className="text-ink-2">{what}</dd>
            </div>
          ))}
        </dl>
        <label className="mt-2 flex items-center gap-3 border-t border-rule pt-4 text-14">
          <input type="checkbox" checked={lettersOn} onChange={(e) => letters.set(e.target.checked)} className="size-4 accent-[var(--primary)]" />
          Single-key shortcuts (T, U and ?) are on
        </label>
        <p className="text-13 text-ink-2">Turn them off if you use speech input or they get in your way. The arrow keys keep working.</p>
      </DialogContent>
    </Dialog>
  );
}
