"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  createProject,
  createTeam,
  currentActor,
  leaveTeam,
  makeCaptain,
  removeMember,
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

/** Leave the team, take a member off it, or hand the captaincy over: the form's "do" says which. */
export async function teamMemberAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const team = String(form.get("team") ?? "");
  const user = String(form.get("user") ?? "");
  const what = String(form.get("do") ?? "");
  let message: string;
  try {
    const actor = await currentActor();
    if (what === "leave") {
      leaveTeam(actor, team);
      message = "You left the team. You can start or join another while submissions are open.";
    } else if (what === "remove") {
      removeMember(actor, team, user);
      message = "Taken off the team.";
    } else if (what === "captain") {
      makeCaptain(actor, team, { userId: user });
      message = "Captaincy handed over.";
    } else {
      return { ok: false, message: "Nothing to do." };
    }
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/events/${String(form.get("event") ?? "")}/my-project`);
  return { ok: true, message };
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
    thumbnailUrl: form.get("thumbnailUrl"),
    // one image address per line; tags separated by commas
    galleryUrls: String(form.get("galleryUrls") ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean),
    tags: String(form.get("tags") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
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
