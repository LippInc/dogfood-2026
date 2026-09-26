"use server";

import { redirect } from "next/navigation";
import { actionError, signUp, type ActionResult } from "@/server/dal";

export async function signUpAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const setup = form.get("setup");
    await signUp({ name: form.get("name"), email: form.get("email"), password: form.get("password"), setup: typeof setup === "string" && setup ? setup : undefined });
  } catch (err) {
    return actionError(err);
  }
  const next = form.get("next");
  redirect(typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/");
}
