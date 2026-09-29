"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  createProject,
  createTeam,
  currentActor,
  dissolveTeam,
  leaveTeam,
  makeCaptain,
  removeMember,
  renameTeam,
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
  const solo = form.get("solo") === "1";
  return { ok: true, message: solo ? "You are in. Your project form is below." : "Team created. Share the invite link with your teammates." };
}

export async function renameTeamAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    renameTeam(await currentActor(), String(form.get("team") ?? ""), { name: form.get("name") });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/events/${String(form.get("event") ?? "")}/my-project`);
  return { ok: true, message: "Renamed." };
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

/** Leave the team, take a member off it, hand the captaincy over, or (its last member) dissolve it: the form's "do" says which. */
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
    } else if (what === "dissolve") {
      const { draftDeleted } = dissolveTeam(actor, team);
      message = `Team dissolved${draftDeleted ? " and its draft deleted" : ""}. You can start or join another while submissions are open.`;
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
  // a field the organizers hid is not on the form, so it is not sent at all (the server keeps what is stored)
  const field = (name: string) => form.get(name) ?? undefined;
  const list = (name: string, by: RegExp) =>
    form.has(name)
      ? String(form.get(name))
          .split(by)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const body = {
    title: field("title"),
    summary: field("summary"),
    description: field("description"),
    trackId: field("trackId"),
    repoUrl: field("repoUrl"),
    videoUrl: field("videoUrl"),
    liveUrl: field("liveUrl"),
    thumbnailUrl: field("thumbnailUrl"),
    // one image address per line, only for a new project (a saved one's gallery changes through its own route); tags separated by commas
    galleryUrls: projectId ? undefined : list("galleryUrls", /\r?\n/),
    tags: list("tags", /,/),
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
