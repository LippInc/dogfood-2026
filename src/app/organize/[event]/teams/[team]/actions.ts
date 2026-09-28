"use server";

import { revalidatePath } from "next/cache";
import { actionError, currentActor, organizerAddMember, organizerRemoveMember, renameTeam, type ActionResult } from "@/server/dal";

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

/** An organizer puts someone with an account on the team, with a reason. */
export async function organizerAddAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    organizerAddMember(await currentActor(), String(form.get("team") ?? ""), { email: form.get("email") ?? "", reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(pageOf(form));
  return { ok: true, message: "Added. The reason is in the audit log." };
}

/** An organizer takes someone off the team, with a reason. */
export async function organizerRemoveAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    organizerRemoveMember(await currentActor(), String(form.get("team") ?? ""), String(form.get("user") ?? ""), { reason: form.get("reason") ?? "" });
  } catch (err) {
    return actionError(err);
  }
  revalidatePath(pageOf(form));
  return { ok: true, message: "Taken off. The reason is in the audit log." };
}
