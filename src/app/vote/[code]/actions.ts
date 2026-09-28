"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { clientOf } from "@/lib/client";
import { actionError, enterVoting, secureCookies, voteCookieName, type ActionResult } from "@/server/dal";

export async function enterAction(_prev: ActionResult, form: FormData): Promise<ActionResult> {
  let slug: string;
  try {
    const jar = await cookies();
    const entered = enterVoting(String(form.get("code") ?? ""), await clientOf(), (eventId) => jar.get(voteCookieName(eventId))?.value);
    jar.set(voteCookieName(entered.eventId), entered.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 60,
      secure: secureCookies(),
    });
    slug = entered.eventSlug;
  } catch (err) {
    return actionError(err);
  }
  redirect(`/events/${slug}/vote`);
}
