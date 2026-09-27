"use server";

import { redirect } from "next/navigation";
import { actionError, homeFor, resetPassword, type ActionResult } from "@/server/dal";

export async function resetAction(token: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  let userId: string;
  try {
    ({ userId } = await resetPassword(token, { password: form.get("password") ?? "" }));
  } catch (err) {
    return actionError(err);
  }
  redirect(homeFor(userId));
}
