"use server";

import { createElement, type ReactNode } from "react";
import { actionError, currentActor, makePasswordReset, type ActionResult } from "@/server/dal";
import { ResetTicket } from "./reset-ticket";

export type ResetLinkResult = ActionResult & { path?: string; email?: string; name?: string; expiresAt?: string; ticket?: ReactNode };

export async function resetLinkAction(_prev: ResetLinkResult, form: FormData): Promise<ResetLinkResult> {
  const actor = await currentActor();
  try {
    const link = makePasswordReset(actor, { email: String(form.get("email") ?? "") });
    // The ticket is drawn here, on the server, because a project face is computed server-side only.
    return { ok: true, message: null, ...link, ticket: createElement(ResetTicket, link) };
  } catch (err) {
    return actionError(err);
  }
}
