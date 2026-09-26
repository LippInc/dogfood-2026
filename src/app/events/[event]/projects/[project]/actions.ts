"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, hideComment, postComment, type ActionResult } from "@/server/dal";

export async function postCommentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const projectId = String(form.get("project") ?? "");
  try {
    postComment(await currentActor(), projectId, { body: form.get("body") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(String(form.get("path") ?? "/"));
  return { ok: true, message: "Posted." };
}

export async function hideCommentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    hideComment(await currentActor(), String(form.get("comment") ?? ""), { reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(String(form.get("path") ?? "/"));
  return { ok: true, message: "Hidden." };
}
