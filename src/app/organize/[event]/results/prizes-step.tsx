"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useFormAction } from "@/components/use-form-action";
import type { ActionResult, PrizeStanding } from "@/server/dal";
import { awardAction } from "./prize-actions";

/** A project that can win, with its place in its track as the ranking stands (null: not placed). */
export type PrizeCandidate = { projectId: string; title: string; teamName: string; trackName: string; place: number | null; joint: boolean };

const idle: ActionResult = { ok: false, message: null };

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;
const placeWords = (c: PrizeCandidate) => (c.place === null ? `not placed in ${c.trackName}` : `${c.joint ? "joint " : ""}${ordinal(c.place)} in ${c.trackName}`);

/**
 * One prize: its winners (one, or several for a joint award), each with its place beside it, and an optional note.
 * Nothing is saved until "Save the award"; a prize with no winner saved is unawarded.
 */
export function PrizeAwardForm({ eventSlug, prize, candidates }: { eventSlug: string; prize: PrizeStanding; candidates: PrizeCandidate[] }) {
  const saved = prize.winners.map((w) => w.projectId);
  const [ids, setIds] = useState<string[]>(saved);
  const [note, setNote] = useState(prize.note);
  const [state, form, pending] = useFormAction(awardAction, idle, { resetOnSuccess: false });
  const byId = new Map(candidates.map((c) => [c.projectId, c]));
  const dirty = ids.join(" ") !== saved.join(" ") || (ids.length > 0 && note.trim() !== prize.note);
  const tracks = [...new Set(candidates.map((c) => c.trackName))];
  const pick = `prize-${prize.prizeId}-add`;
  const noteId = `prize-${prize.prizeId}-note`;
  const e = state.fieldErrors ?? {};
  return (
    <form {...form} className="flex flex-col gap-3" noValidate aria-labelledby={`prize-${prize.prizeId}-name`}>
      <input type="hidden" name="event" value={eventSlug} />
      <input type="hidden" name="prize" value={prize.prizeId} />
      {ids.map((id) => (
        <input key={id} type="hidden" name="projectIds" value={id} />
      ))}
      <p className="text-13 text-ink-2">{ids.length === 0 ? "Unawarded" : ids.length === 1 ? "Winner" : `Joint winners · ${ids.length}`}</p>
      {ids.length ? (
        <ul className="flex flex-col border-t border-rule">
          {ids.map((id) => {
            const c = byId.get(id);
            return (
              <li key={id} className="flex items-center justify-between gap-3 border-b border-rule py-2">
                <span className="min-w-0 wrap-anywhere">
                  <span className="block text-14 font-medium">{c?.title ?? id}</span>
                  <span className="block text-13 text-ink-2">
                    {c ? `${c.teamName} · ${placeWords(c)}` : "no longer a submitted project: it will not count"}
                  </span>
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setIds((xs) => xs.filter((x) => x !== id))} aria-label={`Remove ${c?.title ?? id} from ${prize.name}`}>
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <label className="text-14 font-medium" htmlFor={pick}>
        {ids.length ? "Add a joint winner" : "Give it to"}
      </label>
      <select
        id={pick}
        value=""
        onChange={(ev) => {
          const v = ev.target.value;
          if (v) setIds((xs) => (xs.includes(v) ? xs : [...xs, v]));
        }}
        aria-invalid={Boolean(e.projectIds)}
        className="h-10 w-full min-w-0 rounded-sm border border-edge bg-surface px-3 text-15 aria-[invalid=true]:border-flag-bar"
      >
        <option value="">Choose a project, by its place</option>
        {tracks.map((t) => (
          <optgroup key={t} label={t}>
            {candidates
              .filter((c) => c.trackName === t && !ids.includes(c.projectId))
              .map((c) => (
                <option key={c.projectId} value={c.projectId}>
                  {c.place === null ? "–" : `${c.joint ? "=" : ""}${ordinal(c.place)}`} · {c.title} ({c.teamName})
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      {e.projectIds ? <p className="text-13 text-flag">{e.projectIds[0]}</p> : null}
      <label className="text-14 font-medium" htmlFor={noteId}>
        Note, shown with the prize <span className="font-normal text-ink-2">(optional)</span>
      </label>
      <Textarea id={noteId} name="note" rows={2} maxLength={300} value={note} onChange={(ev) => setNote(ev.target.value)} aria-invalid={Boolean(e.note)} />
      {e.note ? <p className="text-13 text-flag">{e.note[0]}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save the award"}
        </Button>
        <span className="text-13 text-ink-2" aria-live="polite">
          {dirty ? "Changed, not saved yet" : ""}
        </span>
      </div>
      <p role="status" className={`min-h-5 text-13 ${state.ok ? "text-ok" : "text-flag"}`}>
        {dirty ? "" : (state.message ?? "")}
      </p>
    </form>
  );
}
