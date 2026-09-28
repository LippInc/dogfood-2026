"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, renameTeam, type ActionResult } from "@/server/dal";

const pageOf = (form: FormData) => `/organize/${String(form.get("event") ?? "")}/teams/${String(form.get("team") ?? "")}`;

/** An organizer renames a team, with a reason for the audit log. */
export async function organizerRenameAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    renameTeam(await currentActor(), String(form.get("team") ?? ""), { name: form.get("name"), reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(pageOf(form));
  return { ok: true, message: "Renamed. The reason is in the audit log." };
}
