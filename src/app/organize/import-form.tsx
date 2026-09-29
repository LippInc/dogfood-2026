"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

type ImportResult = { ok: boolean; message: string | null; slug?: string };
type Counts = { events: number; tracks: number; users: number; teams: number; projects: number; scores: number; voters?: number; comments?: number; comparisons?: number; normalizationRuns?: number };
type Report = { eventSlug: string; inserted: Counts; skipped: unknown[]; renamed: unknown[]; slug?: { wanted: string; used: string } };

const idle: ImportResult = { ok: false, message: null };

/** A new event's history the file brought, in a few words; nothing when it brought none. */
function history(n: Counts): string {
  const parts = [
    n.voters ? `${n.voters} ${n.voters === 1 ? "ballot" : "ballots"}` : "",
    n.comments ? `${n.comments} ${n.comments === 1 ? "comment" : "comments"}` : "",
    n.comparisons ? `${n.comparisons} pairwise ${n.comparisons === 1 ? "answer" : "answers"}` : "",
    n.normalizationRuns ? "the published results" : "",
  ].filter(Boolean);
  return parts.length ? `, with ${parts.join(", ")}` : "";
}

/** The import's report as a sentence. */
function said(r: Report): string {
  const n = r.inserted;
  const added = Object.values(n).reduce((a: number, b) => a + (b ?? 0), 0);
  return added
    ? `Imported: ${n.tracks} tracks, ${n.teams} teams, ${n.projects} projects, ${n.scores} scores and ${n.users} people${history(n)}${r.skipped.length ? `; ${r.skipped.length} rows skipped` : ""}${r.renamed.length ? `; ${r.renamed.length} ids renamed because another event here already uses them` : ""}${r.slug ? `; its web address is /events/${r.slug.used}, because /events/${r.slug.wanted} belongs to another event` : ""}.`
    : "Everything in this file is here already; nothing changed.";
}

/**
 * The file picker and its button on one line inside a dashed slip (the place a file goes), and
 * the import's report under them: ruled green when it went in, orange when it was refused.
 * The file goes as it is to POST /api/imports, which takes event files up to 64 MB; a server
 * action would be held to the 5 MB every action gets (next.config.ts).
 */
export function ImportEventForm() {
  const [state, setState] = useState<ImportResult>(idle);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File)) return;
    setPending(true);
    try {
      const res = await fetch("/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body: file });
      const answer = (await res.json().catch(() => null)) as (Report & { message?: string }) | null;
      if (res.ok && answer) {
        setState({ ok: true, message: said(answer), slug: answer.eventSlug });
        form.reset();
      } else {
        setState({ ok: false, message: answer?.message ?? `The import failed (${res.status}). Try again.` });
      }
    } catch {
      setState({ ok: false, message: "The file did not reach the portal. Check the connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-[680px] flex-col gap-3 rounded-sm border border-dashed border-edge bg-surface p-4 sm:p-5">
      <label htmlFor="event-file" className="text-14 font-medium">
        Event file (JSON, the fixture format)
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id="event-file"
          name="file"
          type="file"
          accept="application/json,.json"
          required
          className="min-w-0 text-14 text-ink-2 file:mr-3 file:h-10 sm:file:h-8 file:rounded-sm file:border file:border-edge file:bg-raised file:px-3 file:text-14 file:font-medium file:text-ink"
        />
        <Button disabled={pending}>{pending ? "Importing…" : "Import"}</Button>
      </div>
      {state.message ? (
        <p
          role="status"
          className={`border-l-[3px] px-3 py-2 text-14 ${state.ok ? "border-ok text-ink" : "border-flag-bar bg-flag-bg text-flag"}`}
        >
          {state.message}{" "}
          {state.ok && state.slug ? (
            <Link href={`/organize/${state.slug}`} className="inline-flex items-center gap-1 font-medium whitespace-nowrap underline underline-offset-4">
              Open the event
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </p>
      ) : null}
    </form>
  );
}
