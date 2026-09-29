"use server";

import { revalidatePath } from "next/cache";
import { actionError, awardPrize, currentActor, type ActionResult } from "@/server/dal";

// The Prizes step on the organizer's Results page: one prize's winners and note, saved by one audited call in the
// data access layer. This only reads the form and refreshes the pages that show the award.

export async function awardAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  const prize = String(form.get("prize") ?? "");
  const projectIds = form.getAll("projectIds").map(String);
  let changed: boolean;
  try {
    changed = awardPrize(actor, slug, prize, { projectIds, note: String(form.get("note") ?? "") }).changed;
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/events/${slug}`, "layout");
  if (!changed) return { ok: true, message: "Nothing changed: this is already the award." };
  return { ok: true, message: projectIds.length ? "Saved. It is in the audit log." : "Saved: the prize is unawarded again. It is in the audit log." };
}
