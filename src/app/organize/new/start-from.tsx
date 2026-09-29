"use client";

import { createContext, useContext, useId, useState, type ReactNode } from "react";

// "Start from the settings of": a second event from one the person already runs. The choice lives here so the parts
// of the form a source replaces (team size, tracks, prizes) step aside while one is chosen: hidden and disabled, so
// they are neither shown nor sent, and what was typed in them comes back if the choice goes back to a blank event.

type Source = { id: string; name: string };
const Chosen = createContext<Source | null>(null);

export function StartFrom({ events, children }: { events: Source[]; children: ReactNode }) {
  const [sourceId, setSourceId] = useState("");
  const id = useId();
  const chosen = events.find((e) => e.id === sourceId) ?? null;
  return (
    <Chosen.Provider value={chosen}>
      {events.length ? (
        <div className="flex flex-col gap-2 border-b border-rule pb-5">
          <label htmlFor={id} className="flex flex-col gap-1 text-13 text-ink-2">
            Start from the settings of (optional)
            <select
              id={id}
              name="sourceEventId"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
              aria-describedby={`${id}-note`}
              className="h-8 w-full rounded-sm border border-edge bg-surface px-2 text-14 text-ink sm:max-w-md"
            >
              <option value="">Nothing: a blank event</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <p id={`${id}-note`} className="text-13 text-ink-2">
            {chosen
              ? `The new event takes ${chosen.name}'s tracks, rubric (labels, prompts, weights), questions to teams, what teams fill in, team size, prizes, certificate places, judging mode, accent colour and voting rules. Its dates, people, teams, projects, reviews, votes, comments and invitations stay behind. Change any of it in the new event's settings.`
              : "An event you organize: the new one takes its settings, never its people or projects."}
          </p>
        </div>
      ) : null}
      {children}
    </Chosen.Provider>
  );
}

/** A part of the form only a blank event needs: hidden and not sent while a source event is chosen. */
export function BlankOnly({ children, className = "" }: { children: ReactNode; className?: string }) {
  const chosen = useContext(Chosen);
  return (
    <fieldset disabled={Boolean(chosen)} hidden={Boolean(chosen)} className={`m-0 min-w-0 border-0 p-0 ${className}`}>
      {children}
    </fieldset>
  );
}
