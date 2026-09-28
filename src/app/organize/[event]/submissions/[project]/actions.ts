"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, removeAssignment, undoRecusal, type ActionResult } from "@/server/dal";

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
