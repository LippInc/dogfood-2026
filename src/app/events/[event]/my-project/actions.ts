"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  createProject,
  createTeam,
  currentActor,
  rotateInvite,
  updateProject,
  type ActionResult,
} from "@/server/dal";

export async function createTeamAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    createTeam(await currentActor(), slug, { name: form.get("name") });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/events/${slug}/my-project`);
  return { ok: true, message: "Team created. Share the invite link with your teammates." };
}

export async function rotateInviteAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    rotateInvite(await currentActor(), String(form.get("team") ?? ""));
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/events/${String(form.get("event") ?? "")}/my-project`);
  return { ok: true, message: "New link made. The old one no longer works." };
}

export async function saveProjectAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  const projectId = String(form.get("project") ?? "");
  const intent = form.get("intent") === "draft" ? "draft" : "submitted";
  const answers: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith("answer:") && typeof value === "string") answers[key.slice(7)] = value;
  }
  const body = {
    title: form.get("title"),
    summary: form.get("summary"),
    description: form.get("description"),
    trackId: form.get("trackId"),
    repoUrl: form.get("repoUrl"),
    videoUrl: form.get("videoUrl"),
    liveUrl: form.get("liveUrl"),
    answers,
    status: intent,
  };
  let message: string;
  try {
    const actor = await currentActor();
    if (projectId) {
      const saved = updateProject(actor, projectId, body);
      message = saved.status === "submitted" ? "Saved. Your project is submitted." : "Draft saved.";
    } else {
      const created = createProject(actor, slug, body);
      message = created.status === "submitted" ? "Submitted. Your project is in the gallery." : "Draft saved.";
    }
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/events/${slug}/my-project`);
  return { ok: true, message };
}
