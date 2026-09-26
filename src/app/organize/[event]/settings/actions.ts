"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  currentActor,
  savePrizes,
  saveQuestions,
  saveRubric,
  saveTracks,
  updateEventDetails,
  type ActionResult,
} from "@/server/dal";

function rows(form: FormData, name: string): unknown {
  try {
    return JSON.parse(String(form.get(name) ?? "[]"));
  } catch {
    return null;
  }
}

async function run(form: FormData, work: (slug: string) => void, done: string): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  try {
    work(slug);
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(`/organize/${slug}`, "layout");
  revalidatePath(`/events/${slug}`, "layout");
  return { ok: true, message: done };
}

export async function saveDetailsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return run(
    form,
    (slug) =>
      updateEventDetails(actor, slug, {
        name: form.get("name"),
        description: form.get("description"),
        submissionsOpenAt: form.get("submissionsOpenAt"),
        submissionsCloseAt: form.get("submissionsCloseAt"),
        judgingCloseAt: form.get("judgingCloseAt"),
        maxTeamSize: form.get("maxTeamSize"),
      }),
    "Saved. The public pages show the new details now.",
  );
}

export async function saveTracksAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return run(form, (slug) => saveTracks(actor, slug, rows(form, "tracks")), "Tracks saved.");
}

export async function savePrizesAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return run(form, (slug) => savePrizes(actor, slug, rows(form, "prizes")), "Prizes saved.");
}

export async function saveQuestionsAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return run(form, (slug) => saveQuestions(actor, slug, rows(form, "questions")), "Questions saved; teams see them on their project form.");
}

export async function saveRubricAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return run(form, (slug) => saveRubric(actor, slug, rows(form, "rubric")), "Rubric saved. Totals are recomputed from the stored scores.");
}
