"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { castAction } from "./actions";

type Project = { id: string; title: string; summary: string; teamName: string; trackName: string; own: boolean };

/**
 * One ballot, in this voter's own shuffled order. A pick saves at once; the server
 * decides whether it counts (window, limit, who is voting) and the page shows its answer.
 */
export function Ballot({
  eventId,
  projects,
  initialPicks,
  max,
  canVote,
  faces,
}: {
  eventId: string;
  projects: Project[];
  initialPicks: string[];
  max: number;
  canVote: boolean;
  faces: Record<string, React.ReactNode>;
}) {
  const [picks, setPicks] = useState<string[]>(initialPicks);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const left = max - picks.length;

  function toggle(id: string) {
    if (!canVote) return;
    const chosen = picks.includes(id);
    if (!chosen && left === 0) {
      setStatus({ ok: false, text: max === 1 ? "You have used your vote. Take it back to choose another." : `You have used all ${max} votes. Take one back to choose another.` });
      return;
    }
    const next = chosen ? picks.filter((p) => p !== id) : [...picks, id];
    const before = picks;
    setPicks(next);
    setStatus(null);
    startTransition(async () => {
      const res = await castAction(eventId, next);
      if (res.ok) {
        setPicks(res.picks ?? next);
        setStatus({ ok: true, text: "Saved. You can change your picks until voting closes." });
      } else {
        setPicks(before);
        setStatus({ ok: false, text: res.message ?? "Not saved." });
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center justify-between gap-3 border-b border-rule bg-bg/95 px-4 py-3 backdrop-blur sm:-mx-8 sm:px-8 xl:-mx-16 xl:px-16">
        <p className="text-15">
          <span className="font-semibold tnum">
            {picks.length} of {max}
          </span>{" "}
          {max === 1 ? "vote" : "votes"} used{canVote && left > 0 ? `, ${left} left` : ""}
        </p>
        <p role="status" aria-live="polite" className={`text-14 ${status ? (status.ok ? "text-ok" : "text-flag") : "text-ink-2"}`}>
          {pending ? "Saving…" : (status?.text ?? "")}
        </p>
      </div>
      <ol className="divide-y divide-rule border-y border-rule">
        {projects.map((p) => {
          const chosen = picks.includes(p.id);
          return (
            <li key={p.id} className={`tile grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-4 sm:grid-cols-[120px_minmax(0,1fr)_auto] ${chosen ? "lit" : ""}`}>
              <span className="hidden sm:block">{faces[p.id]}</span>
              <span className="min-w-0">
                <span className="block font-display text-20 leading-6">{p.title}</span>
                <span className="mt-1 block text-14 text-ink-2">
                  {p.teamName} · {p.trackName}
                </span>
                {p.summary ? <span className="mt-1 block text-15">{p.summary}</span> : null}
              </span>
              {p.own ? (
                <span className="inline-flex h-11 min-w-[104px] items-center justify-center px-2 text-center text-13 text-ink-2">Your team&rsquo;s project</span>
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(p.id)}
                  disabled={!canVote || pending}
                  aria-pressed={chosen}
                  aria-label={`${chosen ? "Take back your vote for" : "Vote for"} ${p.title}`}
                  className="inline-flex h-11 min-w-[104px] items-center justify-center gap-2 rounded-sm border border-edge px-4 text-15 font-medium hover:bg-raised aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-on-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {chosen ? (
                    <>
                      <Check className="size-4" aria-hidden /> Voted
                    </>
                  ) : (
                    "Vote"
                  )}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
