"use server";

import { redirect } from "next/navigation";
import { acceptJudgeInvite, actionError, currentActor, type ActionResult } from "@/server/dal";

export async function acceptInviteAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    slug = acceptJudgeInvite(await currentActor(), String(form.get("code") ?? "")).eventSlug;
  } catch (err) {
    return actionError(err);
  }
  redirect(`/judge/${slug}`);
}
