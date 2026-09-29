"use server";

import { redirect } from "next/navigation";
import { actionError, createEvent, currentActor, type ActionResult } from "@/server/dal";

function rows(form: FormData, name: string): unknown {
  try {
    return JSON.parse(String(form.get(name) ?? "[]"));
  } catch {
    return null;
  }
}

export async function createEventAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    slug = createEvent(await currentActor(), {
      slug: form.get("slug"),
      sourceEventId: form.get("sourceEventId"),
      details: {
        name: form.get("name"),
        description: form.get("description"),
        submissionsOpenAt: form.get("submissionsOpenAt"),
        submissionsCloseAt: form.get("submissionsCloseAt"),
        judgingCloseAt: form.get("judgingCloseAt"),
        maxTeamSize: form.get("maxTeamSize"),
      },
      tracks: rows(form, "tracks"),
      prizes: rows(form, "prizes"),
    }).slug;
  } catch (err) {
    return actionError(err);
  }
  redirect(`/organize/${slug}`);
}
