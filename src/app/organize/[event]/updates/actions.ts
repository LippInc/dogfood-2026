"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, editUpdate, postUpdate, removeUpdate, type ActionResult } from "@/server/dal";
import { mailedNote } from "@/lib/mail-note";

function refresh(slug: string) {
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/events/${slug}`, "layout");
}

export async function postUpdateAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    const { mail } = await postUpdate(actor, slug, { title: String(form.get("title") ?? ""), body: String(form.get("body") ?? ""), email: form.get("email") === "on" });
    refresh(slug);
    const note = mail ? mailedNote(mail, "participant") : null;
    return { ok: true, message: note ? `Posted. ${note}` : "Posted." };
  } catch (err) {
    return actionError(err);
  }
}

export async function editUpdateAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    editUpdate(actor, slug, String(form.get("update") ?? ""), { title: String(form.get("title") ?? ""), body: String(form.get("body") ?? "") });
    refresh(slug);
    return { ok: true, message: "Saved." };
  } catch (err) {
    return actionError(err);
  }
}

export async function removeUpdateAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const slug = String(form.get("event") ?? "");
  try {
    removeUpdate(actor, slug, String(form.get("update") ?? ""));
    refresh(slug);
    return { ok: true, message: "Removed." };
  } catch (err) {
    return actionError(err);
  }
}
