"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clientOf } from "@/lib/client";
import { actionError, enterVoting, voteCookieName, type ActionResult } from "@/server/dal";

export async function enterAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    const entered = enterVoting(String(form.get("code") ?? ""), await clientOf());
    (await cookies()).set(voteCookieName(entered.eventId), entered.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 60,
      secure: process.env.COOKIE_SECURE === "true",
    });
    slug = entered.eventSlug;
  } catch (err) {
    return actionError(err);
  }
  redirect(`/events/${slug}/vote`);
}
