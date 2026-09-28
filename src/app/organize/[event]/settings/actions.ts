"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  addOrganizer,
  currentActor,
  removeOrganizer,
  savePrizes,
  saveQuestions,
  saveRubric,
  saveTracks,
  setJudgingMode,
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
  let reweighted = false;
  const result = await run(
    form,
    (slug) => {
      reweighted = saveRubric(actor, slug, { criteria: rows(form, "rubric"), reason: String(form.get("reason") ?? "") }).reweighted;
    },
    "Rubric saved. Totals are recomputed from the stored scores.",
  );
  return result.ok && reweighted ? { ok: true, message: "Weights changed. The change and its reason are logged, and the published results will show them." } : result;
}

export async function addOrganizerAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  let added = false;
  const result = await run(form, (slug) => void (added = addOrganizer(actor, slug, { email: form.get("email") }).added), "Added: they see this event under Your events now.");
  return result.ok && !added ? { ok: true, message: "They already organize this event." } : result;
}

export async function removeOrganizerAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  return run(form, (slug) => removeOrganizer(actor, slug, String(form.get("user") ?? "")), "Removed.");
}

export async function saveJudgingModeAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const actor = await currentActor();
  const mode = String(form.get("mode") ?? "");
  let changed = true;
  const saved = await run(
    form,
    (slug) => {
      changed = setJudgingMode(actor, slug, { mode, reason: form.get("reason") }).changed;
    },
    mode === "pairwise" ? "Pairwise from now on: judges see two projects at a time." : "Scores from now on: judges score each project on the rubric.",
  );
  // Saving the mode the event already has changes nothing and logs nothing; say so.
  if (saved.ok && !changed) return { ok: true, message: `Nothing changed: the event already judges ${mode === "pairwise" ? "pairwise" : "by scores"}, so nothing was logged.` };
  return saved;
}
