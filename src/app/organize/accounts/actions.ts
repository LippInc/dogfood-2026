"use server";

import { createElement, type ReactNode } from "react";
import { actionError, currentActor, makePasswordReset, NotFoundError, type ActionResult } from "@/server/dal";
import { ResetTicket } from "./reset-ticket";

export type ResetLinkResult = ActionResult & { path?: string; email?: string; name?: string; expiresAt?: string; ticket?: ReactNode };

export async function resetLinkAction(_prev: ResetLinkResult, form: FormData): Promise<ResetLinkResult> {
  const actor = await currentActor();
  try {
    const link = makePasswordReset(actor, { email: String(form.get("email") ?? "") });
    // The ticket is drawn here, on the server, because a project face is computed server-side only.
    return { ok: true, message: null, ...link, ticket: createElement(ResetTicket, link) };
  } catch (err) {
    // An address with no account is a problem with what was typed: say it at the field, with what to check.
    if (err instanceof NotFoundError) {
      return { ok: false, message: null, fieldErrors: { email: ["No account uses this address. Check the spelling, or ask them which address they signed up with."] } };
    }
    return actionError(err);
  }
}
