"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, saveFinalsScore, type ActionResult } from "@/server/dal";

export async function saveFinalsScoreAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  const slug = String(form.get("event") ?? "");
  const values: Record<string, number> = {};
  for (const [name, v] of form.entries()) {
    if (name.startsWith("c:") && typeof v === "string" && v !== "") values[name.slice(2)] = Number(v);
  }
  try {
    const r = saveFinalsScore(await currentActor(), slug, { finals: String(form.get("finals") ?? ""), project: String(form.get("project") ?? ""), values });
    revalidatePath(`/judge/${slug}/finals`);
    revalidatePath(`/organize/${slug}/finals`);
    return { ok: true, message: `Saved: ${r.total.toFixed(2)}.` };
  } catch (err) {
    return actionError(err);
  }
}
