"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, deleteComment, hideComment, postComment, takeDownProjectImage, unhideComment, type ActionResult } from "@/server/dal";

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

export async function deleteCommentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    deleteComment(await currentActor(), String(form.get("comment") ?? ""));
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(String(form.get("path") ?? "/"));
  return { ok: true, message: "Deleted." };
}

export async function unhideCommentAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    unhideComment(await currentActor(), String(form.get("comment") ?? ""));
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(String(form.get("path") ?? "/"));
  return { ok: true, message: "Shown again." };
}

export async function takeDownPictureAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    takeDownProjectImage(await currentActor(), String(form.get("project") ?? ""), { reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(String(form.get("path") ?? "/"));
  return { ok: true, message: "Taken down." };
}
