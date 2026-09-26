"use server";

import { revalidatePath } from "next/cache";
import {
  actionError,
  createWebhook,
  currentActor,
  retryDelivery,
  rotateWebhookSecret,
  setWebhookEnabled,
  testWebhook,
  type ActionResult,
} from "@/server/dal";

export type SecretResult = ActionResult & { secret?: string };

const refresh = (slug: string) => revalidatePath(`/organize/${slug}/integrations`);

export async function addWebhookAction(_prev: SecretResult, form: FormData): Promise<SecretResult> {
  const slug = String(form.get("event") ?? "");
  const picked = form.getAll("actions").map(String);
  try {
    const { secret } = await createWebhook(await currentActor(), slug, {
      url: form.get("url") ?? "",
      actions: picked.includes("*") || picked.length === 0 ? ["*"] : picked,
    });
    refresh(slug);
    return { ok: true, message: "Webhook added. Copy its secret now: it is shown only this once.", secret };
  } catch (err) {
    return actionError(err);
  }
}

export async function rotateSecretAction(_prev: SecretResult, form: FormData): Promise<SecretResult> {
  const slug = String(form.get("event") ?? "");
  try {
    const { secret } = rotateWebhookSecret(await currentActor(), slug, String(form.get("webhook") ?? ""));
    refresh(slug);
    return { ok: true, message: "New secret. The old one no longer signs anything.", secret };
  } catch (err) {
    return actionError(err);
  }
}

/** The small one-click buttons: turn on or off, test, retry. Errors show as the page's error state. */
export async function toggleWebhook(slug: string, webhookId: string, enabled: boolean) {
  setWebhookEnabled(await currentActor(), slug, webhookId, enabled);
  refresh(slug);
}

export async function sendTest(slug: string, webhookId: string) {
  testWebhook(await currentActor(), slug, webhookId);
  refresh(slug);
}

export async function retry(slug: string, webhookId: string, deliveryId: string) {
  retryDelivery(await currentActor(), slug, webhookId, deliveryId);
  refresh(slug);
}
