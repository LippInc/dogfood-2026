"use server";

import { redirect } from "next/navigation";
import { actionError, createEvent, currentActor, EVENT_FILE_TOO_LARGE, guardImport, importEventFile, MAX_EVENT_FILE_BYTES, type ActionResult } from "@/server/dal";

function rows(form: FormData, name: string): unknown {
  try {
    return JSON.parse(String(form.get(name) ?? "[]"));
  } catch {
    return null;
  }
}

export async function createEventAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    slug = createEvent(await currentActor(), {
      slug: form.get("slug"),
      details: {
        name: form.get("name"),
        description: form.get("description"),
        submissionsOpenAt: form.get("submissionsOpenAt"),
        submissionsCloseAt: form.get("submissionsCloseAt"),
        judgingCloseAt: form.get("judgingCloseAt"),
        maxTeamSize: form.get("maxTeamSize"),
      },
      tracks: rows(form, "tracks"),
      prizes: rows(form, "prizes"),
    }).slug;
  } catch (err) {
    return actionError(err);
  }
  redirect(`/organize/${slug}`);
}

export type ImportResult = ActionResult & { slug?: string };

/** An administrator imports an event file (the fixture format); the report comes back as a sentence. */
export async function importEventAction(_prev: ImportResult, form: FormData): Promise<ImportResult> {
  const file = form.get("file");
  let body: unknown;
  try {
    guardImport(await currentActor());
    if (file instanceof File && file.size > MAX_EVENT_FILE_BYTES) return { ok: false, message: EVENT_FILE_TOO_LARGE };
  } catch (err) {
    return actionError(err);
  }
  try {
    body = file instanceof File ? JSON.parse(await file.text()) : undefined;
  } catch {
    body = undefined;
  }
  try {
    const r = importEventFile(await currentActor(), body);
    const n = r.inserted;
    const added = n.events + n.tracks + n.users + n.teams + n.projects + n.scores;
    const message = added
      ? `Imported: ${n.tracks} tracks, ${n.teams} teams, ${n.projects} projects, ${n.scores} scores and ${n.users} people${r.skipped.length ? `; ${r.skipped.length} rows skipped` : ""}${r.renamed.length ? `; ${r.renamed.length} ids renamed because another event here already uses them` : ""}.`
      : "Everything in this file is here already; nothing changed.";
    return { ok: true, message, slug: r.eventSlug };
  } catch (err) {
    return actionError(err);
  }
}
