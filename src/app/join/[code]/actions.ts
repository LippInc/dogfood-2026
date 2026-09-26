"use server";

import { redirect } from "next/navigation";
import { actionError, currentActor, joinTeam, type ActionResult } from "@/server/dal";

export async function joinTeamAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    slug = joinTeam(await currentActor(), String(form.get("code") ?? "")).eventSlug;
  } catch (err) {
    return actionError(err);
  }
  redirect(`/events/${slug}/my-project`);
}
