"use server";

import { redirect } from "next/navigation";
import { actionError, signUp, type ActionResult } from "@/server/dal";

export async function signUpAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    await signUp({ name: form.get("name"), email: form.get("email"), password: form.get("password") });
  } catch (err) {
    return actionError(err);
  }
  const next = form.get("next");
  redirect(typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/");
}
