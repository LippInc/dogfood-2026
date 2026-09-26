"use server";

import { revalidatePath } from "next/cache";
import { actionError, createApiToken, currentActor, revokeApiToken, type ActionResult } from "@/server/dal";

export type TokenResult = ActionResult & { token?: string };

export async function createTokenAction(_prev: TokenResult, form: FormData): Promise<TokenResult> {
  const days = String(form.get("days") ?? "90");
  try {
    const { token } = createApiToken(await currentActor(), { name: form.get("name") ?? "", days: days === "never" ? null : days });
    revalidatePath("/account/tokens");
    return { ok: true, message: "Copy the token now: it is shown only this once.", token };
  } catch (err) {
    return actionError(err);
  }
}

export async function revokeTokenAction(tokenId: string) {
  revokeApiToken(await currentActor(), tokenId);
  revalidatePath("/account/tokens");
}
