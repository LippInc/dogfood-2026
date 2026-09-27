"use client";

import { Check, CircleAlert, CloudOff, Lock } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatUtc, weightShares } from "@/lib/format";
import type { ConsoleItem, Criterion, JudgeConsole } from "@/server/dal";
import { Kbd, letters, paragraphs, ProjectLink } from "./judge-bits";

// The judge console (DESIGN.md: the judge keys with autosave and "your ranking so
// far"). Three panes that scroll on their own: the batch rail in the judge's seeded
// order, the project as a document, and the score pane. Every change is saved
// ~400 ms later through PUT /api/judge/reviews/<assignment>; the server decides
// whether this judge may save it, the page only mirrors the answer.

type Review = {
  values: Record<string, number | null>;
  feedback: string;
  privateNote: string;
  status: ConsoleItem["status"];
  readOnly: string | null;
  version: number;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "offline" }
  | { kind: "error"; message: string };

const SAVE_DELAY = 400;

const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

function totalOf(criteria: Criterion[], values: Record<string, number | null>): number | null {
  let sum = 0;
  let weights = 0;
  for (const c of criteria) {
    const v = values[c.key];
    if (v === null || v === undefined) return null;
    sum += c.weight * v;
    weights += c.weight;
  }
  return criteria.length ? sum / weights : null;
}

/** "(5 + 4 + 3) ÷ 3" with equal weights, "(2×5 + 1×4) ÷ 3" otherwise. */
function formula(criteria: Criterion[], values: Record<string, number | null>): string | null {
  if (criteria.some((c) => values[c.key] == null)) return null;
  const equal = criteria.every((c) => c.weight === criteria[0]!.weight);
  if (equal) return `(${criteria.map((c) => values[c.key]).join(" + ")}) ÷ ${criteria.length}`;
  const sum = criteria.reduce((s, c) => s + c.weight, 0);
  return `(${criteria.map((c) => `${num(c.weight)}×${values[c.key]}`).join(" + ")}) ÷ ${num(sum)}`;
}

function initialReviews(items: ConsoleItem[]): Record<string, Review> {
  return Object.fromEntries(
    items.map((i) => [
      i.assignmentId,
      { values: i.values, feedback: i.feedback, privateNote: i.privateNote, status: i.status, readOnly: i.readOnly, version: 0 },
    ]),
  );
}

export function JudgeConsoleView({
  data,
  faces,
  startProject,
}: {
  data: JudgeConsole;
  faces: Record<string, { small: React.ReactNode; large: React.ReactNode }>;
  startProject: string | null;
}) {
  const { criteria, items } = data;
  const [reviews, setReviews] = useState<Record<string, Review>>(() => initialReviews(items));
  const reviewsRef = useRef(reviews);
  useLayoutEffect(() => {
    reviewsRef.current = reviews;
  }, [reviews]);
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({});
  const [index, setIndex] = useState(() => {
    const asked = startProject ? items.findIndex((i) => i.project.id === startProject) : -1;
    if (asked >= 0) return asked;
    const pending = items.findIndex((i) => i.status === "pending");
    return pending >= 0 ? pending : 0;
  });
  const [focus, setFocus] = useState(0);
  const lettersOn = useSyncExternalStore(letters.subscribe, letters.get, () => true);
  const [keysOpen, setKeysOpen] = useState(false);
  const [recuseOpen, setRecuseOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  // Keys that jump into the feedback box put the caret after what is already there.
  const focusFeedback = useCallback(() => {
    const box = feedbackRef.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }, []);
  const scorePaneRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLDivElement>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inflight = useRef(new Set<string>());
  const again = useRef(new Set<string>());
  const retryDelay = useRef(new Map<string, number>());
  const flushRef = useRef<(id: string) => Promise<void>>(async () => {});

  const current = items[index];
  const review = current ? reviews[current.assignmentId]! : null;
  const readOnly = review?.readOnly ?? null;

  // Keep the address bar on the open project, so a reload lands on it.
  useEffect(() => {
    if (!current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("project", current.project.id);
    window.history.replaceState(null, "", url);
    docRef.current?.scrollTo({ top: 0 });
  }, [current]);

  const flush = useCallback(async (id: string) => {
    const pendingTimer = timers.current.get(id);
    if (pendingTimer) clearTimeout(pendingTimer);
    timers.current.delete(id);
    if (inflight.current.has(id)) {
      again.current.add(id);
      return;
    }
    const r = reviewsRef.current[id];
    if (!r || r.readOnly) return;
    inflight.current.add(id);
    setSaveState((s) => ({ ...s, [id]: { kind: "saving" } }));
    const sent = r.version;
    try {
      const res = await fetch(`/api/judge/reviews/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: r.values, feedback: r.feedback, privateNote: r.privateNote }),
      });
      if (res.status >= 500) throw new Error(`server ${res.status}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // A refusal is final for this page: show the server's words and stop editing.
        setSaveState((s) => ({ ...s, [id]: { kind: "error", message: body.message ?? "Not saved." } }));
        if (res.status === 401 || res.status === 403) {
          setReviews((all) => ({ ...all, [id]: { ...all[id]!, readOnly: body.message ?? "You can no longer change this review." } }));
        }
        return;
      }
      retryDelay.current.delete(id);
      setReviews((all) => ({ ...all, [id]: { ...all[id]!, status: body.status } }));
      setSaveState((s) => ({ ...s, [id]: { kind: "saved", at: new Date() } }));
      if (reviewsRef.current[id]?.version !== sent) again.current.add(id);
    } catch {
      // Offline or the server hiccuped: the review stays in this tab and retries.
      const delay = Math.min((retryDelay.current.get(id) ?? 1000) * 2, 15_000);
      retryDelay.current.set(id, delay);
      setSaveState((s) => ({ ...s, [id]: { kind: "offline" } }));
      timers.current.set(
        id,
        setTimeout(() => void flushRef.current(id), delay),
      );
    } finally {
      inflight.current.delete(id);
      if (again.current.delete(id)) void flushRef.current(id);
    }
  }, []);
  useLayoutEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  const schedule = useCallback(
    (id: string) => {
      const t = timers.current.get(id);
      if (t) clearTimeout(t);
      timers.current.set(
        id,
        setTimeout(() => void flush(id), SAVE_DELAY),
      );
    },
    [flush],
  );

  const edit = useCallback(
    (id: string, change: Partial<Pick<Review, "values" | "feedback" | "privateNote">>) => {
      setReviews((all) => {
        const r = all[id]!;
        if (r.readOnly) return all;
        return { ...all, [id]: { ...r, ...change, values: change.values ?? r.values, version: r.version + 1 } };
      });
      schedule(id);
    },
    [schedule],
  );

  // Warn before leaving with a change that has not reached the server.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (timers.current.size > 0 || inflight.current.size > 0) e.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, []);

  const score = useCallback(
    (criterionIndex: number, value: number) => {
      if (!current) return;
      const c = criteria[criterionIndex];
      if (!c) return;
      const r = reviewsRef.current[current.assignmentId]!;
      if (r.values[c.key] === value) return;
      edit(current.assignmentId, { values: { ...r.values, [c.key]: value } });
    },
    [criteria, current, edit],
  );

  const go = useCallback(
    (to: number) => {
      if (!items.length) return;
      if (current) void flush(current.assignmentId);
      setIndex(((to % items.length) + items.length) % items.length);
      setFocus(0);
      setNoteOpen(false);
    },
    [current, flush, items.length],
  );

  const saveAndNext = useCallback(() => {
    if (!current) return;
    void flush(current.assignmentId);
    const after = [...items.slice(index + 1), ...items.slice(0, index)];
    const next = after.find((i) => {
      const r = reviewsRef.current[i.assignmentId]!;
      return r.status !== "recused" && !r.readOnly && totalOf(criteria, r.values) === null;
    });
    go(next ? items.indexOf(next) : index + 1);
  }, [criteria, current, flush, go, index, items]);

  useEffect(() => {
    const open = () => setKeysOpen(true);
    window.addEventListener("judge:keys", open);
    return () => window.removeEventListener("judge:keys", open);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const inText = Boolean(target?.closest("textarea, input, select, [contenteditable='true']"));
      if (keysOpen || recuseOpen) return;
      if (e.key === "Escape" && inText) {
        target?.blur();
        scorePaneRef.current?.focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        saveAndNext();
        return;
      }
      if (inText || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!criteria.length) return;
        e.preventDefault();
        setFocus((f) => Math.max(0, Math.min(criteria.length - 1, f + (e.key === "ArrowDown" ? 1 : -1))));
        return;
      }
      // Character keys can be turned off (WCAG 2.1.4); letters never fire in a text box.
      if (!lettersOn) return;
      if (e.key === "?") {
        e.preventDefault();
        setKeysOpen(true);
        return;
      }
      const c = criteria[focus];
      if (/^[0-9]$/.test(e.key) && c && !readOnly) {
        const value = Number(e.key);
        if (value < c.scaleMin || value > c.scaleMax) return;
        e.preventDefault();
        score(focus, value);
        if (focus < criteria.length - 1) setFocus(focus + 1);
        else focusFeedback();
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "c" && !readOnly) {
        e.preventDefault();
        focusFeedback();
      } else if (key === "j") {
        e.preventDefault();
        go(index + 1);
      } else if (key === "k") {
        e.preventDefault();
        go(index - 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [criteria, focus, focusFeedback, go, index, keysOpen, lettersOn, readOnly, recuseOpen, saveAndNext, score]);

  const active = items.filter((i) => reviews[i.assignmentId]!.status !== "recused");
  const done = active.filter((i) => totalOf(criteria, reviews[i.assignmentId]!.values) !== null).length;
  const left = active.length - done;

  const ranking = useMemo(() => {
    const rows = items
      .filter((i) => reviews[i.assignmentId]!.status !== "recused")
      .map((i) => ({ id: i.assignmentId, title: i.project.title, total: totalOf(criteria, reviews[i.assignmentId]!.values) }))
      .filter((r): r is { id: string; title: string; total: number } => r.total !== null)
      .sort((a, b) => b.total - a.total || a.title.localeCompare(b.title));
    const key = (t: number) => t.toFixed(2);
    return rows.map((r, i) => {
      const first = rows.findIndex((x) => key(x.total) === key(r.total));
      const size = rows.filter((x) => key(x.total) === key(r.total)).length;
      return { ...r, rank: first + 1, groupStart: first === i, tied: size > 1, groupEnd: i === first + size - 1 };
    });
  }, [criteria, items, reviews]);

  if (!current || !review) {
    return (
      <div className="mx-auto max-w-[680px] px-4 py-16">
        <p className="label-mono text-ink-3">Your batch</p>
        <h1 className="mt-3 text-24 font-semibold">No projects are assigned to you yet</h1>
        <p className="mt-3 text-15 text-ink-2">
          The organizers assign projects after submissions close. This page fills in when they do; nothing to do until then.
        </p>
      </div>
    );
  }

  const state = saveState[current.assignmentId] ?? { kind: "idle" };
  const total = totalOf(criteria, review.values);
  const shares = weightShares(criteria.map((c) => c.weight));
  const scaleMin = Math.min(...criteria.map((c) => c.scaleMin));
  const scaleMax = Math.max(...criteria.map((c) => c.scaleMax));
  const currentRank = ranking.find((r) => r.id === current.assignmentId);
  const p = current.project;
  const body = paragraphs(p.description);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] lg:h-[calc(100dvh-3rem)] lg:grid-cols-[288px_minmax(0,1fr)_416px]">
      {/* Rail: the judge's own order */}
      <aside aria-label="Your batch" className="flex flex-col border-b border-rule bg-surface lg:min-h-0 lg:border-r lg:border-b-0">
        <div className="border-b border-rule px-5 pt-6 pb-4">
          <div className="flex items-baseline justify-between">
            <h2 className="text-15 font-semibold">Your batch</h2>
            <p className="text-13 text-ink-2 tnum">
              {done} of {active.length} done
            </p>
          </div>
          <ol className="mt-3 flex gap-1" aria-hidden>
            {items.map((i, n) => {
              const r = reviews[i.assignmentId]!;
              const finished = totalOf(criteria, r.values) !== null;
              return (
                <li
                  key={i.assignmentId}
                  className={`h-1.5 flex-1 rounded-[1px] border ${
                    n === index
                      ? "border-accent bg-accent"
                      : r.status === "recused"
                        ? "border-rule bg-sunken"
                        : finished
                          ? "border-ink bg-ink"
                          : "border-edge bg-transparent"
                  }`}
                />
              );
            })}
          </ol>
          <p className="mt-3 text-13 text-ink-2">
            {active.length === 0
              ? "Nothing left to review: you declared a conflict on every project in your batch."
              : left === 0
              ? "Every project reviewed. You can still change a score until judging closes."
              : data.minutesPerReview
                ? `About ${Math.max(1, Math.round(data.minutesPerReview * left))} min left at your pace`
                : `${left} still to review`}
          </p>
        </div>
        <ol className="flex-1 overflow-y-auto max-lg:max-h-56">
          {items.map((i, n) => {
            const r = reviews[i.assignmentId]!;
            const t = totalOf(criteria, r.values);
            const here = n === index;
            return (
              <li key={i.assignmentId}>
                <button
                  type="button"
                  onClick={() => go(n)}
                  aria-current={here ? "true" : undefined}
                  className={`flex w-full items-center gap-3 border-b border-rule px-5 py-3 text-left hover:bg-raised ${
                    here ? "lit border-l-[3px] border-l-accent bg-accent-tint pl-[17px]" : ""
                  }`}
                >
                  <span className="w-5 font-mono text-12 text-ink-3 tnum">{String(n + 1).padStart(2, "0")}</span>
                  <span className="w-12 shrink-0">{faces[i.project.id]?.small}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-14 font-medium">{i.project.title}</span>
                    <span className="block truncate text-12 text-ink-2">{i.project.trackName}</span>
                  </span>
                  <span className={`text-13 tnum ${here ? "font-medium text-accent-ink" : "text-ink-2"}`}>
                    {r.status === "recused" ? "recused" : here && t === null ? "scoring" : t === null ? "–" : t.toFixed(2)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <div className="flex flex-col gap-3 border-t border-rule px-5 py-4 text-13 text-ink-2">
          <p>Your order is shuffled, so no project is always read first or last.</p>
          <p>
            Know this team?{" "}
            <button
              type="button"
              onClick={() => setRecuseOpen(true)}
              disabled={Boolean(readOnly)}
              className="text-ink underline underline-offset-4 disabled:text-ink-3 disabled:no-underline"
            >
              Declare a conflict of interest
            </button>
            .
          </p>
          <div className="max-lg:hidden">
            <KeyHints lettersOn={lettersOn} />
          </div>
        </div>
      </aside>

      {/* The project, as a document */}
      <article ref={docRef} aria-labelledby="project-title" className="min-w-0 lg:overflow-y-auto">
        <div className="mx-auto max-w-[680px] px-6 py-8 wrap-anywhere lg:px-0">
          <p className="text-14 text-ink-2">
            Project {index + 1} of {items.length} · {p.trackName}
            {p.submittedAt ? ` · submitted ${formatUtc(p.submittedAt, { weekday: true })}` : ""}
          </p>
          <div className="mt-4 flex items-start justify-between gap-6">
            <div className="min-w-0">
              <h1 id="project-title" className="font-serif text-38 font-semibold">
                {p.title}
              </h1>
              {p.summary ? <p className="mt-2 font-serif text-20 text-ink-2">{p.summary}</p> : null}
              <p className="mt-4 text-14 text-ink-2">
                by <span className="font-semibold text-ink">{p.teamName}</span> · {p.teamSize} {p.teamSize === 1 ? "member" : "members"}
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
            </div>
            <div className="hidden shrink-0 sm:block">
              <div className="w-32">{faces[p.id]?.large}</div>
              <p className="mt-2 font-mono text-12 text-ink-3">{p.id}</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <ProjectLink label="Repository" url={p.repoUrl} />
            <ProjectLink label="Demo video" url={p.videoUrl} />
            <ProjectLink label="Live demo" url={p.liveUrl} />
            {[p.thumbnailUrl, ...p.galleryUrls]
              .filter((u): u is string => Boolean(u))
              .map((u, n, all) => (
                <ProjectLink key={u} label={all.length === 1 ? "Image" : `Image ${n + 1}`} url={u} />
              ))}
          </div>
          <div className="mt-8 border-t border-rule pt-6">
            <h2 className="text-14 font-semibold">About the project</h2>
            {body.length ? (
              body.map((para, n) => (
                <p key={n} className="mt-4 font-serif text-17 leading-8">
                  {para}
                </p>
              ))
            ) : (
              <p className="mt-4 text-15 text-ink-2">The team wrote no longer description; the summary above is all there is.</p>
            )}
          </div>
          {p.answers.length ? (
            <div className="mt-10 border-t border-rule pt-6">
              <h2 className="text-14 font-semibold">Organizer&rsquo;s questions</h2>
              <dl>
                {p.answers.map((a) => (
                  <div key={a.label} className="mt-4">
                    <dt className="text-14 text-ink-2">{a.label}</dt>
                    <dd className="mt-1 font-serif text-17 leading-8 whitespace-pre-line">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
        </div>
      </article>

      {/* The score pane */}
      <section
        ref={scorePaneRef}
        tabIndex={-1}
        aria-labelledby="score-title"
        className="flex flex-col border-t border-rule bg-surface outline-none lg:min-h-0 lg:border-t-0 lg:border-l"
      >
        <div className="flex-1 px-6 pt-6 pb-4 lg:overflow-y-auto">
          <div className="flex items-center justify-between">
            <h2 id="score-title" className="text-15 font-semibold">
              Your score
            </h2>
            <SaveStatus state={state} />
          </div>
          {readOnly ? (
            <p className="mt-3 flex items-start gap-2 border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-13 text-flag">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {readOnly}
            </p>
          ) : null}
          <div className="mt-2 flex flex-col">
            {criteria.map((c, ci) => {
              const value = review.values[c.key] ?? null;
              const levels = Array.from({ length: c.scaleMax - c.scaleMin + 1 }, (_, k) => c.scaleMin + k);
              const focused = ci === focus;
              return (
                <div
                  key={c.id}
                  role="group"
                  aria-labelledby={`crit-${c.key}`}
                  onFocusCapture={() => setFocus(ci)}
                  className={`border-b border-rule py-4 ${focused ? "shadow-[inset_3px_0_0_var(--accent)] -mx-6 px-6" : ""}`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p>
                      <span id={`crit-${c.key}`} className="text-15 font-semibold">
                        {c.label}
                      </span>
                      {c.prompt ? <span className="ml-2 text-13 text-ink-2">{c.prompt}</span> : null}
                    </p>
                    <span className="shrink-0 text-13 text-ink-2">weight {shares[ci]}</span>
                  </div>
                  <div className="mt-3 flex">
                    {levels.map((level, li) => (
                      <button
                        key={level}
                        type="button"
                        aria-pressed={value === level}
                        aria-label={`${level}${c.anchors[String(level)] ? `: ${c.anchors[String(level)]}` : ""}`}
                        title={c.anchors[String(level)] ?? undefined}
                        disabled={Boolean(readOnly)}
                        onClick={() => score(ci, level)}
                        className={`h-10 flex-1 border border-edge text-15 font-medium tnum -ml-px first:ml-0 hover:bg-raised focus-visible:z-10 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-on-primary disabled:cursor-not-allowed disabled:text-ink-3 disabled:aria-pressed:text-on-primary ${
                          li === 0 ? "rounded-l-sm" : ""
                        } ${li === levels.length - 1 ? "rounded-r-sm" : ""}`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 min-h-[18px] text-13 text-ink-2">
                    {value !== null ? (
                      <>
                        <span className="font-semibold text-ink tnum">{value}</span> {c.anchors[String(value)] ?? ""}
                      </>
                    ) : focused && !readOnly ? (
                      <span className="text-ink-3">
                        Press {c.scaleMin} to {c.scaleMax <= 9 ? c.scaleMax : "…"}, or click a level.
                      </span>
                    ) : (
                      ""
                    )}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="flex items-baseline justify-between py-4">
            <p className="text-15 font-semibold">Your total</p>
            <p className="flex items-baseline gap-3">
              <span className="font-mono text-12 text-ink-2">{formula(criteria, review.values) ? `${formula(criteria, review.values)} =` : ""}</span>
              <span className="text-38 leading-none font-semibold tnum">{total === null ? "–" : total.toFixed(2)}</span>
            </p>
          </div>
          {data.showRanking ? (
            <div className="rounded-sm border border-rule">
              <div className="flex items-baseline justify-between border-b border-rule px-3 py-2">
                <p className="text-14 font-semibold">Your ranking so far</p>
                <p className="text-12 text-ink-2">only your own scores</p>
              </div>
              {ranking.length === 0 ? (
                <p className="px-3 py-3 text-13 text-ink-2">Finish a review and it lands here, ranked by your own totals.</p>
              ) : (
                <ol className="py-1">
                  {ranking.map((r) => {
                    const mine = r.id === current.assignmentId;
                    return (
                      <li
                        key={r.id}
                        className={`grid grid-cols-[22px_12px_minmax(0,1fr)_72px_40px] items-center gap-1 px-3 py-0.5 text-13 ${
                          mine ? "bg-accent-tint shadow-[inset_3px_0_0_var(--accent)]" : ""
                        }`}
                      >
                        <span className="text-12 text-ink-3 tnum">{r.groupStart ? r.rank : ""}</span>
                        <span
                          aria-hidden
                          className={`h-full ${r.tied ? `border-l border-edge ${r.groupStart ? "mt-2 border-t" : ""} ${r.groupEnd ? "mb-2 border-b" : ""}` : ""}`}
                        />
                        <span className="truncate">
                          {r.title}
                          {mine ? (
                            <span className="ml-2 text-12 text-accent-ink">
                              this project{r.rank === 1 && !r.tied && ranking.length > 1 ? " · new top" : r.tied ? " · tied" : ""}
                            </span>
                          ) : r.tied && r.groupStart ? (
                            <span className="ml-2 text-12 text-ink-3">tied</span>
                          ) : null}
                        </span>
                        <span className="h-1 rounded-full bg-sunken">
                          <span
                            className={`block h-1 rounded-full ${mine ? "bg-accent" : "bg-ink-3"}`}
                            style={{ width: `${Math.max(4, ((r.total - scaleMin) / Math.max(1, scaleMax - scaleMin)) * 100)}%` }}
                          />
                        </span>
                        <span className="text-right tnum">{r.total.toFixed(2)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {currentRank === undefined && !readOnly ? (
                <p className="border-t border-rule px-3 py-2 text-12 text-ink-3">This project joins the list when every criterion has a score.</p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-5">
            <label htmlFor="feedback" className="text-14 font-semibold">
              Feedback to the team
            </label>
            <span className="ml-2 text-12 text-ink-2 wrap-anywhere">shown to {p.teamName} after results</span>
            <Textarea
              id="feedback"
              ref={feedbackRef}
              rows={4}
              value={review.feedback}
              readOnly={Boolean(readOnly)}
              onChange={(e) => edit(current.assignmentId, { feedback: e.target.value })}
              className="mt-2 font-serif text-15 leading-6"
              placeholder="What worked, what to fix first."
            />
          </div>
          <div className="mt-3">
            <button
              type="button"
              aria-expanded={noteOpen}
              aria-controls="private-note"
              onClick={() => setNoteOpen((o) => !o)}
              className="text-13 font-medium text-ink"
            >
              {noteOpen ? "−" : "+"} Private note to organizers
            </button>
            <span className="ml-2 text-12 text-ink-2">never shown to the team</span>
            {noteOpen ? (
              <Textarea
                id="private-note"
                rows={3}
                value={review.privateNote}
                readOnly={Boolean(readOnly)}
                onChange={(e) => edit(current.assignmentId, { privateNote: e.target.value })}
                className="mt-2 text-14"
              />
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule px-6 py-3">
          <Button size="lg" onClick={saveAndNext}>
            {readOnly ? "Open next" : "Save and open next"}
            <kbd className="ml-2 rounded-[2px] border border-current/40 px-1 font-mono text-12 max-lg:hidden">Ctrl ↵</kbd>
          </Button>
          {readOnly ? null : (
            <Button size="lg" variant="ghost" onClick={() => go(index + 1)}>
              Skip for now
            </Button>
          )}
        </div>
      </section>

      <KeysDialog
        open={keysOpen}
        onOpenChange={setKeysOpen}
        lettersOn={lettersOn}
        onLetters={letters.set}
      />
      <RecuseDialog
        open={recuseOpen}
        onOpenChange={setRecuseOpen}
        teamName={p.teamName}
        assignmentId={current.assignmentId}
        onDone={(message) => {
          setReviews((all) => ({ ...all, [current.assignmentId]: { ...all[current.assignmentId]!, status: "recused", readOnly: message } }));
          setRecuseOpen(false);
        }}
      />
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-13 text-ink-2">
      {state.kind === "saving" ? (
        "Saving…"
      ) : state.kind === "saved" ? (
        <>
          <Check className="size-3.5 text-ok" aria-hidden />
          Saved {state.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
        </>
      ) : state.kind === "offline" ? (
        <>
          <CloudOff className="size-3.5 text-flag" aria-hidden />
          <span className="text-flag">Offline, kept here, retrying</span>
        </>
      ) : state.kind === "error" ? (
        <>
          <CircleAlert className="size-3.5 text-flag" aria-hidden />
          <span className="text-flag">{state.message}</span>
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
      <li className={lettersOn ? "" : "opacity-50"}>
        <Kbd>1</Kbd>–<Kbd>5</Kbd> score
      </li>
      <li>
        <Kbd>↑</Kbd>
        <Kbd>↓</Kbd> criterion
      </li>
      <li className={lettersOn ? "" : "opacity-50"}>
        <Kbd>C</Kbd> feedback
      </li>
      <li className={lettersOn ? "" : "opacity-50"}>
        <Kbd>J</Kbd>
        <Kbd>K</Kbd> move
      </li>
      <li className="col-span-2">
        <Kbd>Ctrl</Kbd>
        <Kbd>↵</Kbd> save, next · <Kbd>?</Kbd> all keys
      </li>
    </ul>
  );
}

function KeysDialog({
  open,
  onOpenChange,
  lettersOn,
  onLetters,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lettersOn: boolean;
  onLetters: (on: boolean) => void;
}) {
  const rows: [React.ReactNode, string][] = [
    [
      <>
        <Kbd>1</Kbd> to <Kbd>5</Kbd>
      </>,
      "Score the current criterion and move to the next one; after the last, the feedback box",
    ],
    [
      <>
        <Kbd>↑</Kbd> <Kbd>↓</Kbd>
      </>,
      "Move between criteria",
    ],
    [<Kbd key="c">C</Kbd>, "Write feedback to the team"],
    [<Kbd key="esc">Esc</Kbd>, "Leave a text box"],
    [
      <>
        <Kbd>Ctrl</Kbd> <Kbd>Enter</Kbd>
      </>,
      "Save and open the next project you have not finished",
    ],
    [
      <>
        <Kbd>J</Kbd> <Kbd>K</Kbd>
      </>,
      "Next and previous project in your batch",
    ],
    [<Kbd key="q">?</Kbd>, "This list"],
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keys</DialogTitle>
          <DialogDescription>Letters and digits never fire while you type in a text box. Every change saves by itself.</DialogDescription>
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
          <input type="checkbox" checked={lettersOn} onChange={(e) => onLetters(e.target.checked)} className="size-4 accent-[var(--primary)]" />
          Single-key shortcuts (letters, digits and ?) are on
        </label>
        <p className="text-13 text-ink-2">Turn them off if you use speech input or they get in your way. Arrows, Esc and Ctrl + Enter keep working.</p>
      </DialogContent>
    </Dialog>
  );
}

function RecuseDialog({
  open,
  onOpenChange,
  teamName,
  assignmentId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  assignmentId: string;
  onDone: (message: string) => void;
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
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.details?.reason?.[0] ?? body.message ?? "Not recorded.");
        return;
      }
      setReason("");
      onDone("You declared a conflict of interest, so this project left your batch. The organizers can see why.");
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
            If you know {teamName} or worked with them, you should not score them. The project leaves your batch, your scores for it no longer count,
            and the organizers see your reason. This cannot be undone from here.
          </DialogDescription>
        </DialogHeader>
        <label htmlFor="recuse-reason" className="text-14 font-medium">
          Why, in a few words
        </label>
        <Textarea id="recuse-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={Boolean(error)} />
        {error ? <p className="text-13 text-flag">{error}</p> : null}
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
