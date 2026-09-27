"use server";

import { actionError, currentActor, makePasswordReset, type ActionResult } from "@/server/dal";

export type ResetLinkResult = ActionResult & { path?: string; email?: string; name?: string; expiresAt?: string };

export async function resetLinkAction(_prev: ResetLinkResult, form: FormData): Promise<ResetLinkResult> {
  const actor = await currentActor();
  try {
    const link = makePasswordReset(actor, { email: String(form.get("email") ?? "") });
    return { ok: true, message: null, ...link };
  } catch (err) {
    return actionError(err);
  }
}
