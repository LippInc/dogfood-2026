"use server";

import { redirect } from "next/navigation";
import { actionError, claimAccount, describeClaim, type ActionResult } from "@/server/dal";

export async function claimAction(token: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    slug = describeClaim(token).eventSlug;
    await claimAccount(token, { password: form.get("password") ?? "", name: String(form.get("name") ?? "").trim() || undefined });
  } catch (err) {
    return actionError(err);
  }
  redirect(`/events/${slug}`);
}
