"use server";

import { revalidatePath } from "next/cache";
import { actionError, createApiToken, currentActor, revokeApiToken, type ActionResult } from "@/server/dal";

export type TokenResult = ActionResult & { token?: string; name?: string; expiresAt?: string | null };

export async function createTokenAction(_prev: TokenResult, form: FormData): Promise<TokenResult> {
  const days = String(form.get("days") ?? "90");
  try {
    const { token, name, expiresAt } = createApiToken(await currentActor(), { name: form.get("name") ?? "", days: days === "never" ? null : days });
    revalidatePath("/account/tokens");
    return { ok: true, message: "Copy it now: the portal keeps only its hash, so it cannot show it again. Its mark is in the list below.", token, name, expiresAt };
  } catch (err) {
    return actionError(err);
  }
}

export async function revokeTokenAction(tokenId: string) {
  revokeApiToken(await currentActor(), tokenId);
  revalidatePath("/account/tokens");
}
