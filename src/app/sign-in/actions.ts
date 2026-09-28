"use server";

import { redirect } from "next/navigation";
import { clientOf } from "@/lib/client";
import { safeNext } from "@/lib/safe-next";
import { homeFor, signInAsDemo, signInWithPassword } from "@/server/dal";

export type SignInState = { message: string | null };

export async function passwordSignIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const result = await signInWithPassword(String(form.get("email") ?? ""), String(form.get("password") ?? ""), await clientOf());
  if (!result.ok) return { message: result.message };
  redirect(safeNext(form.get("next")) ?? homeFor(result.userId));
}

export async function demoSignIn(form: FormData): Promise<void> {
  const result = await signInAsDemo(String(form.get("label") ?? ""));
  if (!result.ok) redirect("/sign-in?demo=off");
  // Back to the page that sent you here, like a password sign-in; only a path on this site.
  redirect(safeNext(form.get("next")) ?? homeFor(result.userId));
}
