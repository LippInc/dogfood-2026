"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, moveProjectTrack, removeAssignment, undoRecusal, type ActionResult, type TrackMove } from "@/server/dal";
import { plural } from "@/lib/format";

// The organizer's corrections to one project's judging. Each is one audited call in the data
// access layer; these actions only read the form and refresh the pages that show the result.

async function correct(form: FormData, work: (slug: string) => unknown, done: string): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    work(slug);
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/judge/${slug}`);
  return { ok: true, message: done };
}

export async function removeAssignmentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return correct(
    form,
    (slug) => removeAssignment(actor, slug, String(form.get("assignment") ?? ""), { reason: form.get("reason") ?? "" }),
    "Taken back. It has left the judge's list; a top-up on the Judges page fills the seat from another judge.",
  );
}

export async function undoRecusalAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return correct(
    form,
    (slug) => undoRecusal(actor, slug, String(form.get("assignment") ?? ""), { reason: form.get("reason") ?? "" }),
    "Given back. The review is in the judge's list again and counts as it did before.",
  );
}

export async function moveTrackAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  let move: TrackMove | null = null;
  const done = await correct(
    form,
    (slug) => {
      move = moveProjectTrack(actor, slug, String(form.get("project") ?? ""), { trackId: form.get("trackId") ?? "", reason: form.get("reason") ?? "" });
      revalidatePath(`/events/${slug}`, "layout");
    },
    "",
  );
  const m = move as TrackMove | null;
  if (!done.ok || !m) return done;
  if (!m.moved) return { ok: true, message: "It is in that track already; nothing changed." };
  const parts = [
    m.withdrawn ? `${plural(m.withdrawn, "unstarted review")} withdrawn` : null,
    m.finishedKept ? `${plural(m.finishedKept, "finished review")} still ${m.finishedKept === 1 ? "counts" : "count"}` : null,
    m.startedKept ? `${plural(m.startedKept, "started review")} kept in the record, out of ${m.startedKept === 1 ? "its judge's list" : "their judges' lists"}` : null,
  ].filter(Boolean);
  return { ok: true, message: `Moved.${parts.length ? ` ${parts.join("; ")}.` : ""} Run a top-up on the Judges page to give it judges from its new track.` };
}
