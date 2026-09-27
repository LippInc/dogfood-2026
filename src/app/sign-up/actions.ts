"use server";

import { redirect } from "next/navigation";
import { clientOf } from "@/lib/client";
import { safeNext } from "@/lib/safe-next";
import { actionError, signUp, type ActionResult } from "@/server/dal";

export async function signUpAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  try {
    const setup = form.get("setup");
    await signUp(
      { name: form.get("name"), email: form.get("email"), password: form.get("password"), setup: typeof setup === "string" && setup ? setup : undefined },
      await clientOf(),
    );
  } catch (err) {
    return actionError(err);
  }
  redirect(safeNext(form.get("next")) ?? "/");
}
