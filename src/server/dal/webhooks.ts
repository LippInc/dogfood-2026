import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { webhookDeliveries, webhooks } from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { newId, newSecret, nowIso } from "../util";
import { targetProblem } from "../webhooks";
import { eventFacts, requireEvent } from "./events";
import { parse } from "./parse";

// The organizer's side of webhooks: add one (its secret is shown once), turn it off
// and on, give it a new secret, send a test, read the delivery log, retry a
// delivery. Every change is audited; secrets never enter the audit log.

export const WebhookInput = z.object({
  url: z.string().trim().url("that is not a URL").max(500),
  actions: z.array(z.string().trim().min(1).max(60)).min(1, "choose at least one action").max(100).default(["*"]),
});

type EventRow = ReturnType<typeof requireEvent>;

/** The organizer gate, decided (and a refusal audited) before any input is looked at. */
function organizerEvent(actor: Actor | null, eventIdOrSlug: string): EventRow {
  const event = requireEvent(getDb(), eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return event;
}

function hookIn(tx: DbOrTx, eventId: string, webhookId: string) {
  const hook = tx.select().from(webhooks).where(and(eq(webhooks.id, webhookId), eq(webhooks.eventId, eventId))).get();
  if (!hook) throw new NotFoundError("Webhook");
  return hook;
}

function organizerChange<T>(actor: Actor | null, event: EventRow, run: Parameters<typeof mutate<T>>[0]["run"]): T {
  return mutate({ actor, action: "event.manage", load: (tx) => ({ kind: "event", event: eventFacts(requireEvent(tx, event.id)) }), run });
}

export async function createWebhook(actor: Actor | null, eventIdOrSlug: string, body: unknown): Promise<{ id: string; secret: string }> {
  const event = organizerEvent(actor, eventIdOrSlug);
  const input = parse(WebhookInput, body);
  const problem = await targetProblem(input.url);
  if (problem) throw new ValidationError(`This URL cannot receive webhooks: ${problem}.`, { url: [problem] });
  const actions = [...new Set(input.actions)].sort();
  return organizerChange(actor, event, (tx) => {
    const id = newId("whk", 12);
    const secret = `whsec_${newSecret(24)}`;
    tx.insert(webhooks).values({ id, eventId: event.id, url: input.url, secret, actions, createdAt: nowIso(), createdBy: actor!.userId }).run();
    return { result: { id, secret }, audit: { action: "webhook.create", eventId: event.id, targetType: "webhook", targetId: id, after: { url: input.url, actions } } };
  });
}

export function setWebhookEnabled(actor: Actor | null, eventIdOrSlug: string, webhookId: string, enabled: boolean) {
  const event = organizerEvent(actor, eventIdOrSlug);
  return organizerChange(actor, event, (tx) => {
    const hook = hookIn(tx, event.id, webhookId);
    if (enabled === !hook.disabledAt) return { result: { id: hook.id, enabled }, audit: null };
    tx.update(webhooks).set({ disabledAt: enabled ? null : nowIso() }).where(eq(webhooks.id, hook.id)).run();
    return { result: { id: hook.id, enabled }, audit: { action: enabled ? "webhook.enable" : "webhook.disable", eventId: event.id, targetType: "webhook", targetId: hook.id } };
  });
}

/** A new secret; the old one stops signing at once. Returned once. */
export function rotateWebhookSecret(actor: Actor | null, eventIdOrSlug: string, webhookId: string): { id: string; secret: string } {
  const event = organizerEvent(actor, eventIdOrSlug);
  return organizerChange(actor, event, (tx) => {
    const hook = hookIn(tx, event.id, webhookId);
    const secret = `whsec_${newSecret(24)}`;
    tx.update(webhooks).set({ secret }).where(eq(webhooks.id, hook.id)).run();
    return { result: { id: hook.id, secret }, audit: { action: "webhook.rotate_secret", eventId: event.id, targetType: "webhook", targetId: hook.id } };
  });
}

/** Queue a webhook.test delivery to this webhook only, whatever it subscribes to. */
export function testWebhook(actor: Actor | null, eventIdOrSlug: string, webhookId: string): { id: string } {
  const event = organizerEvent(actor, eventIdOrSlug);
  return organizerChange(actor, event, (tx) => {
    const hook = hookIn(tx, event.id, webhookId);
    if (hook.disabledAt) throw new ValidationError("Turn the webhook on before testing it.");
    return { result: { id: hook.id }, audit: { action: "webhook.test", eventId: event.id, targetType: "webhook", targetId: hook.id } };
  });
}

/** Send a delivery again at the next pass of the worker. */
export function retryDelivery(actor: Actor | null, eventIdOrSlug: string, webhookId: string, deliveryId: string): { id: string } {
  const event = organizerEvent(actor, eventIdOrSlug);
  return organizerChange(actor, event, (tx) => {
    const hook = hookIn(tx, event.id, webhookId);
    const d = tx
      .select({ id: webhookDeliveries.id, status: webhookDeliveries.status })
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, hook.id)))
      .get();
    if (!d) throw new NotFoundError("Delivery");
    if (d.status === "delivered") throw new ValidationError("This delivery already arrived.");
    tx.update(webhookDeliveries).set({ status: "pending", nextAttemptAt: nowIso() }).where(eq(webhookDeliveries.id, d.id)).run();
    return { result: { id: d.id }, audit: { action: "webhook.redeliver", eventId: event.id, targetType: "webhook", targetId: hook.id, after: { delivery: d.id } } };
  });
}

export type WebhookView = {
  id: string;
  url: string;
  actions: string[];
  enabled: boolean;
  createdAt: string;
  counts: { pending: number; delivered: number; failed: number };
};

export function listWebhooks(actor: Actor | null, eventIdOrSlug: string): { event: EventRow; webhooks: WebhookView[] } {
  const event = organizerEvent(actor, eventIdOrSlug);
  const db = getDb();
  const counts = db
    .select({ webhookId: webhookDeliveries.webhookId, status: webhookDeliveries.status, n: sql<number>`count(*)` })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(eq(webhooks.eventId, event.id))
    .groupBy(webhookDeliveries.webhookId, webhookDeliveries.status)
    .all();
  const hooks = db.select().from(webhooks).where(eq(webhooks.eventId, event.id)).orderBy(webhooks.createdAt).all();
  return {
    event,
    webhooks: hooks.map((h) => {
      const c = { pending: 0, delivered: 0, failed: 0 };
      for (const r of counts) if (r.webhookId === h.id) c[r.status] = r.n;
      return { id: h.id, url: h.url, actions: h.actions, enabled: !h.disabledAt, createdAt: h.createdAt, counts: c };
    }),
  };
}

/** The last 50 deliveries of one webhook, newest first, with what went out and what came back. */
export function listDeliveries(actor: Actor | null, eventIdOrSlug: string, webhookId: string) {
  const event = organizerEvent(actor, eventIdOrSlug);
  const db = getDb();
  const hook = hookIn(db, event.id, webhookId);
  return db
    .select({
      id: webhookDeliveries.id,
      action: webhookDeliveries.action,
      status: webhookDeliveries.status,
      attempts: webhookDeliveries.attempts,
      responseStatus: webhookDeliveries.responseStatus,
      responseBody: webhookDeliveries.responseBody,
      error: webhookDeliveries.error,
      payload: webhookDeliveries.payload,
      createdAt: webhookDeliveries.createdAt,
      lastAttemptAt: webhookDeliveries.lastAttemptAt,
      nextAttemptAt: webhookDeliveries.nextAttemptAt,
      deliveredAt: webhookDeliveries.deliveredAt,
    })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, hook.id))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(50)
    .all();
}
