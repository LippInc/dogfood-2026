import "server-only";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { getDb, type DbOrTx } from "./db/client";
import { events, webhookDeliveries, webhooks } from "./db/schema";
import { newId } from "./util";

// Webhooks ride on the audit log: appendAudit() calls enqueueForAudit() inside the
// same transaction as the change, so a delivery exists exactly when the change
// committed. The worker (startWebhookWorker, started at boot) POSTs due deliveries,
// signed with each webhook's secret, and retries with backoff.

/** Wait after failed attempt n (1-based) before trying again; the attempt after the last is final. */
export const RETRY_DELAYS_S = [10, 60, 300, 1800, 7200] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
const TIMEOUT_MS = 5000;
/** A delivery is claimed for this long before it is sent: longer than any send takes, so a pass that dies mid-send
 *  leaves the delivery to go out again once the claim runs out (at least once, never lost). */
export const CLAIM_MS = 60_000;

export type AuditRowForHook = {
  id: number;
  at: string;
  action: string;
  eventId: string | null;
  actorUserId: string | null;
  actorLabel: string;
  targetType: string | null;
  targetId: string | null;
  before: unknown;
  after: unknown;
  hash: string;
};

// What a delivery keeps of a sealed row's before and after. A ballot's picks, a judge's
// scores and a judge's pairwise answers stay in the portal (the log holds them in full):
// the receiver learns who acted, on what and when, never the values. A ballot changes
// only while voting is open; scores and answers come before the results are published.
const SEALED = new Map<string, readonly string[]>([
  ["vote.cast", []],
  ["review.save", ["project"]],
  ["review.submit", ["project"]],
  ["review.amend", ["project"]],
  ["pairwise.pick", ["trackId"]],
  ["pairwise.undo", ["trackId"]],
]);
// A pairwise answer also hides its project: binary insertion asks next about the half the
// last answer chose, and a tie ends a placement early, so the projects give the answers away.
const TARGET_SEALED = new Set(["pairwise.pick", "pairwise.undo"]);

function keep(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const kept = Object.fromEntries(keys.filter((k) => k in value).map((k) => [k, (value as Record<string, unknown>)[k]]));
  return Object.keys(kept).length ? kept : null;
}

/** The body a webhook receives: the audited change as the log recorded it (values sealed as above), with its hash. */
export function payloadFor(deliveryId: string, row: AuditRowForHook, eventSlug: string | null): Record<string, unknown> {
  const sealed = SEALED.get(row.action);
  return {
    id: deliveryId,
    type: row.action,
    createdAt: row.at,
    event: { id: row.eventId, slug: eventSlug },
    data: {
      auditId: row.id,
      at: row.at,
      actor: { userId: row.actorUserId, label: row.actorLabel },
      target: { type: row.targetType, id: TARGET_SEALED.has(row.action) ? null : row.targetId },
      before: sealed ? keep(row.before, sealed) : (row.before ?? null),
      after: sealed ? keep(row.after, sealed) : (row.after ?? null),
      hash: row.hash,
    },
  };
}

/** Queue one delivery per enabled webhook of the row's event that subscribes to its action. */
export function enqueueForAudit(tx: DbOrTx, row: AuditRowForHook): number {
  if (!row.eventId) return 0;
  const enabled = tx
    .select({ id: webhooks.id, actions: webhooks.actions })
    .from(webhooks)
    .where(and(eq(webhooks.eventId, row.eventId), isNull(webhooks.disabledAt)))
    .all();
  // A test goes to the webhook it names, and only there.
  const hooks =
    row.action === "webhook.test"
      ? enabled.filter((h) => h.id === row.targetId)
      : enabled.filter((h) => h.actions.includes("*") || h.actions.includes(row.action));
  if (!hooks.length) return 0;
  const slug = tx.select({ slug: events.slug }).from(events).where(eq(events.id, row.eventId)).get()?.slug ?? null;
  for (const h of hooks) {
    const id = newId("dlv", 14);
    tx.insert(webhookDeliveries)
      .values({ id, webhookId: h.id, auditId: row.id, action: row.action, payload: payloadFor(id, row, slug), nextAttemptAt: row.at, createdAt: row.at })
      .run();
  }
  return hooks.length;
}

/** "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}` with the webhook's secret>" */
export function signatureHeader(secret: string, body: string, t: number): string {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

/** What a receiver does: recompute the signature and refuse anything older than the tolerance. */
export function verifySignature(secret: string, body: string, header: string, nowMs = Date.now(), toleranceS = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1 || Math.abs(nowMs / 1000 - t) > toleranceS) return false;
  const expected = Buffer.from(signatureHeader(secret, body, t).split("v1=")[1]!, "hex");
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const allowPrivate = () => process.env.WEBHOOKS_ALLOW_PRIVATE === "true";

/** Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses. */
export function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return privateAddress(x.slice(7));
    return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("ff");
  }
  return true;
}

/**
 * Why a URL may not receive webhooks, or null when it may. Private and local targets
 * are refused (so an organizer cannot make the portal call the machines around it)
 * unless WEBHOOKS_ALLOW_PRIVATE=true, for a test receiver on the same host.
 */
export async function targetProblem(url: string, opts: { forDelivery?: boolean } = {}): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a URL";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "only http and https URLs";
  if (u.username || u.password) return "no user name or password in the URL";
  if (allowPrivate()) return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "it points at this machine";
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    // When a webhook is added a name that does not resolve yet (or an offline portal)
    // proves nothing either way; each delivery checks again and does not send.
    return opts.forDelivery ? "its host name does not resolve" : null;
  }
  return addresses.some(privateAddress) ? "it resolves to a private or local address" : null;
}

/** delivered: arrived; retrying: failed this time, tried again later; failed: failed for good. */
export type DeliveryOutcome = { attempted: number; delivered: number; retrying: number; failed: number };

/**
 * Send every due delivery once (oldest first); a failure is retried later, the last one is final. Each delivery is
 * claimed before it is sent, so two passes at once, or two portal processes on one database, do not both send it.
 */
export async function deliverDue(opts: { now?: Date; limit?: number; fetchImpl?: typeof fetch } = {}): Promise<DeliveryOutcome> {
  const db = getDb();
  const now = opts.now ?? new Date();
  const due = db
    .select({ d: webhookDeliveries, url: webhooks.url, secret: webhooks.secret, disabledAt: webhooks.disabledAt })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.nextAttemptAt, now.toISOString())))
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(opts.limit ?? 20)
    .all();
  const out: DeliveryOutcome = { attempted: 0, delivered: 0, retrying: 0, failed: 0 };
  for (const { d, url, secret, disabledAt } of due) {
    // The claim: move the next attempt CLAIM_MS ahead, only if no other pass has moved it since this one read the
    // row. Both passes see the row as due; SQLite takes one write at a time, so one claim lands and the other skips.
    const claim = db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: new Date(now.getTime() + CLAIM_MS).toISOString() })
      .where(and(eq(webhookDeliveries.id, d.id), eq(webhookDeliveries.status, "pending"), eq(webhookDeliveries.nextAttemptAt, d.nextAttemptAt!)))
      .run();
    if (claim.changes !== 1) continue;
    out.attempted++;
    const attempt = d.attempts + 1;
    let status: number | null = null;
    let text = "";
    let error: string | null = null;
    const problem = disabledAt ? "the webhook is turned off" : await targetProblem(url, { forDelivery: true });
    if (problem) {
      error = `not sent: ${problem}`;
    } else {
      const body = JSON.stringify(d.payload);
      try {
        const res = await (opts.fetchImpl ?? fetch)(url, {
          method: "POST",
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: {
            "content-type": "application/json",
            "user-agent": "dogfood-portal-webhooks/1",
            "dogfood-event": d.action,
            "dogfood-delivery": d.id,
            "dogfood-signature": signatureHeader(secret, body, Math.floor(now.getTime() / 1000)),
          },
        });
        status = res.status;
        text = (await res.text().catch(() => "")).slice(0, 500);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    const ok = status !== null && status >= 200 && status < 300;
    const final = !ok && (attempt >= MAX_ATTEMPTS || Boolean(disabledAt));
    db.update(webhookDeliveries)
      .set({
        attempts: attempt,
        lastAttemptAt: now.toISOString(),
        responseStatus: status,
        responseBody: text || null,
        error: ok ? null : (error ?? `answered ${status}`),
        status: ok ? "delivered" : final ? "failed" : "pending",
        deliveredAt: ok ? now.toISOString() : null,
        nextAttemptAt: ok || final ? null : new Date(now.getTime() + RETRY_DELAYS_S[attempt - 1]! * 1000).toISOString(),
      })
      .where(eq(webhookDeliveries.id, d.id))
      .run();
    out[ok ? "delivered" : final ? "failed" : "retrying"]++;
  }
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Poll for due deliveries every few seconds in the server process; idempotent. */
export function startWebhookWorker(intervalMs = 2000): void {
  if (timer) return;
  timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await deliverDue();
    } catch (err) {
      console.error("[webhooks] delivery pass failed:", err);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
}
