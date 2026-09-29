"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { leavesPage } from "@/lib/leaves-page";
import { castAction } from "./actions";
import { BallotSaver, type SaverView } from "./ballot-saver";

type Project = { id: string; title: string; summary: string; teamName: string; trackName: string; own: boolean };

/**
 * One ballot, in this voter's own shuffled order. A pick saves at once; the server
 * decides whether it counts (window, limit, who is voting) and the page shows its answer.
 *
 * `canVote` false draws the same ballot without its buttons: a visitor sees what they would
 * vote on and the bar says how to take part (`cta`); a vote that has not opened says when.
 */
export function Ballot({
  eventId,
  projects,
  initialPicks,
  max,
  canVote,
  cta,
  faces,
  slotFaces,
}: {
  eventId: string;
  projects: Project[];
  initialPicks: string[];
  max: number;
  canVote: boolean;
  /** what the bar offers when this request cannot vote: a link (sign in) or a plain line (opens on ...) */
  cta?: { href: string; label: string } | { text: string };
  faces: Record<string, React.ReactNode>;
  /** small faces for the ballot slots in the sticky bar */
  slotFaces: Record<string, React.ReactNode>;
}) {
  // What the page draws comes from the saver: a pick shows at once, saves one at a time in order,
  // and a lost connection or a refusal says so on the status line (see ballot-saver.ts).
  const [view, setView] = useState<SaverView>({ phase: "idle", picks: initialPicks });
  const [saver] = useState(() => new BallotSaver((next) => castAction(eventId, next), setView, initialPicks));
  // a note that is not about saving ("you have used all your votes"), until the next pick
  const [note, setNote] = useState<string | null>(null);
  const [show, setShow] = useState<string>("all");
  const picks = view.picks;
  const left = max - picks.length;
  const titles = Object.fromEntries(projects.map((p) => [p.id, p.title]));
  const tracks = [...new Set(projects.map((p) => p.trackName))].sort();
  const shown = projects.filter((p) => (show === "all" ? true : show === "picks" ? picks.includes(p.id) : p.trackName === show));

  useEffect(() => {
    saver.attach();
    // back online: send a waiting save now instead of at the next retry
    const online = () => saver.retryNow();
    // when the voter already said yes on a link below, the browser need not ask a second time
    let confirmedAt = 0;
    // leaving with a pick the server does not hold yet: the browser asks first (a full page load)
    const unload = (e: BeforeUnloadEvent) => {
      if (saver.unsaved() && Date.now() - confirmedAt > 2000) e.preventDefault();
    };
    // ...and so does the page for a link that changes the page without a full load (the shell's
    // section links), which beforeunload never sees. Capture phase on the document runs before
    // next/link's own handler, which leaves a click alone once it is defaultPrevented.
    const click = (e: MouseEvent) => {
      if (!saver.unsaved()) return;
      const a = e.target instanceof Element ? e.target.closest("a") : null;
      if (!a) return;
      const leaving = leavesPage(
        {
          href: a.getAttribute("href"),
          target: a.getAttribute("target"),
          download: a.hasAttribute("download"),
          button: e.button,
          modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
          defaultPrevented: e.defaultPrevented,
        },
        window.location.href,
      );
      if (!leaving) return;
      if (window.confirm("Your latest change to the ballot is not saved yet. Leave this page anyway?")) confirmedAt = Date.now();
      else e.preventDefault();
    };
    window.addEventListener("online", online);
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
      // gone anyway (the back button, or the voter said leave): a waiting save goes out now, not never
      saver.leave();
    };
  }, [saver]);

  function toggle(id: string) {
    if (!canVote) return;
    const chosen = picks.includes(id);
    if (!chosen && left === 0) {
      setNote(max === 1 ? "You have used your vote. Take it back to choose another." : `You have used all ${max} votes. Take one back to choose another.`);
      return;
    }
    setNote(null);
    saver.want(chosen ? picks.filter((p) => p !== id) : [...picks, id]);
  }

  const status: { ok: boolean; text: string } | null = note
    ? { ok: false, text: note }
    : view.phase === "saving"
      ? { ok: true, text: "Saving…" }
      : view.phase === "offline"
        ? { ok: false, text: "Not saved yet: the connection dropped. Trying again…" }
        : view.phase === "failed"
          ? { ok: false, text: "Not saved: the portal answered with an error. Reload the page to see your ballot and try again." }
          : view.phase === "refused"
          ? { ok: false, text: view.message }
          : view.phase === "saved"
            ? {
                ok: true,
                text:
                  picks.length === max
                    ? "Ballot complete and saved. You can still change it until voting closes."
                    : "Saved. You can change your picks until voting closes.",
              }
            : null;

  const chip = (key: string, label: string, n: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setShow(key)}
      aria-pressed={show === key}
      className="inline-flex h-9 shrink-0 items-center gap-2 rounded-sm border border-rule px-3 text-14 text-ink-2 hover:bg-raised hover:text-ink aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-bg"
    >
      {label}
      <span className="font-mono text-12 tnum opacity-80">{n}</span>
    </button>
  );

  return (
    <section aria-labelledby="ballot-title" className="flex flex-col">
      <h2 id="ballot-title" className="sr-only">
        The ballot
      </h2>
      <div className="sticky top-0 z-10 -mx-4 border-b border-rule bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8 xl:-mx-16 xl:px-16">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 items-center gap-4">
            <p className="label-mono hidden text-ink-3 lg:block">Your ballot</p>
            {/* the ballot's slots: each pick drops its face into the next one */}
            <ol className={`flex gap-1.5 ${!canVote && cta && "href" in cta ? "max-sm:hidden" : ""}`} aria-hidden="true">
              {Array.from({ length: Math.min(max, 10) }, (_, i) => {
                const id = picks[i];
                return (
                  <li
                    key={id ?? `empty-${i}`}
                    title={id ? titles[id] : undefined}
                    className={`h-[27px] w-12 overflow-hidden rounded-xs sm:h-9 sm:w-16 ${id ? "lit stamp border border-accent" : "border border-dashed border-edge"}`}
                  >
                    {id ? slotFaces[id] : <span className="flex h-full items-center justify-center font-mono text-12 text-ink-3">{i + 1}</span>}
                  </li>
                );
              })}
            </ol>
            <p className="text-15">
              <span className="font-semibold tnum">
                {picks.length} of {max}
              </span>{" "}
              {max === 1 ? "vote" : "votes"} used
              {canVote && left > 0 ? <span className="text-ink-2">, {left} left</span> : null}
            </p>
          </div>
          {canVote || !cta ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <p role="status" aria-live="polite" className={`text-14 ${status && view.phase !== "saving" ? (status.ok ? "text-ok" : "text-flag") : "text-ink-2"}`}>
                {status?.text ?? ""}
              </p>
              {/* a server fault does not mend by itself (see ballot-saver.ts): a fresh page shows what the server holds */}
              {view.phase === "failed" && !note ? (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex h-9 items-center rounded-sm border border-edge px-3 text-14 font-medium hover:bg-raised"
                >
                  Reload
                </button>
              ) : null}
            </div>
          ) : "href" in cta ? (
            <Link
              href={cta.href}
              className="inline-flex h-10 items-center rounded-sm border border-primary bg-primary px-4 text-15 font-medium text-on-primary hover:opacity-90"
            >
              {cta.label}
            </Link>
          ) : (
            <p className="text-14 text-ink-2">{cta.text}</p>
          )}
        </div>
      </div>

      {/* a ballot of 40 is long: narrow it to a track, or to the picks to look them over */}
      {projects.length > 8 ? (
        <div role="group" aria-label="Show" className="-mx-4 flex gap-2 overflow-x-auto px-4 pt-5 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
          {chip("all", "All projects", projects.length)}
          {canVote || picks.length ? chip("picks", "Your picks", picks.length) : null}
          {tracks.length > 1 ? tracks.map((t) => chip(t, t, projects.filter((p) => p.trackName === t).length)) : null}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="mt-6 rounded-sm border border-dashed border-edge px-5 py-6 text-15 text-ink-2">
          {show === "picks" ? "No picks yet. Choose Vote on a project to put it on your ballot." : "No projects here."}
        </p>
      ) : (
        <ol className="mt-6 grid gap-x-6 sm:grid-cols-2 sm:gap-y-10 lg:grid-cols-3 xl:grid-cols-5">
          {shown.map((p) => {
            const chosen = picks.includes(p.id);
            return (
              <li
                key={p.id}
                className={`tile grid grid-cols-[72px_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-rule py-4 first:pt-0 sm:flex sm:flex-col sm:items-stretch sm:border-0 sm:py-0 ${chosen ? "lit" : ""}`}
              >
                <div className="relative mt-1 sm:mt-0 sm:self-stretch">
                  <div className={`overflow-hidden rounded-xs border ${chosen ? "border-accent" : "border-rule"}`}>{faces[p.id]}</div>
                  {chosen ? (
                    <span className="stamp absolute left-2 top-2 hidden items-center gap-1 rounded-xs bg-accent px-1.5 py-0.5 font-mono text-12 text-on-accent sm:inline-flex">
                      <Check className="size-3" aria-hidden /> Picked
                    </span>
                  ) : null}
                  <span className="crop-marks" aria-hidden="true" />
                </div>
                <div className="min-w-0 wrap-anywhere sm:flex-1">
                  <h3 className="font-display text-17 leading-6 sm:mt-4 sm:text-20">{p.title}</h3>
                  {p.summary ? <p className="mt-1 text-14 text-ink-2 sm:text-15">{p.summary}</p> : null}
                  <p className="mt-1.5 text-13 text-ink-3">
                    {p.teamName} · {p.trackName}
                  </p>
                </div>
                {p.own ? (
                  <p className="inline-flex h-11 w-[88px] items-center justify-center rounded-sm border border-dashed border-rule px-2 text-center text-12 leading-4 text-ink-2 sm:mt-4 sm:w-auto sm:text-13">
                    Your team&rsquo;s project
                  </p>
                ) : canVote ? (
                  <button
                    type="button"
                    onClick={() => toggle(p.id)}
                    aria-pressed={chosen}
                    aria-label={`${chosen ? "Take back your vote for" : "Vote for"} ${p.title}`}
                    className="inline-flex h-11 w-[88px] items-center justify-center gap-1.5 rounded-sm border border-edge text-15 font-medium hover:bg-raised aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent sm:mt-4 sm:w-auto"
                  >
                    {chosen ? (
                      <>
                        <Check className="size-4" aria-hidden /> Voted
                      </>
                    ) : (
                      "Vote"
                    )}
                  </button>
                ) : chosen ? (
                  <p className="inline-flex items-center gap-1.5 pt-1 text-14 font-medium text-accent-ink sm:mt-4 sm:pt-0">
                    <Check className="size-4" aria-hidden /> <span className="max-sm:sr-only">On your ballot</span>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
