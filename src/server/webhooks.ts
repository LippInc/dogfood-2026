import "server-only";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
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
  // an import names the judges and reviews it added, scores included: the receiver gets the counts
  ["fixtures.import", ["source", "sha256", "inserted"]],
]);
// A pairwise answer also hides its project: binary insertion asks next about the half the
// last answer chose, and a tie ends a placement early, so the projects give the answers away.
const TARGET_SEALED = new Set(["pairwise.pick", "pairwise.undo"]);

/** Whether a delivery of this action leaves values out; appendAudit hashes such a row with a salt the body never carries (src/server/audit.ts). */
export function sealsValues(action: string): boolean {
  return SEALED.has(action);
}

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

// An action that took over part of another one's job also goes to the older action's subscribers,
// so a receiver set up before the split keeps hearing about the same saves. A voting settings save
// that changes who may vote or the votes per voter after the first ballot is voting.rules_changed.
const ALSO_SUBSCRIBED_AS: Record<string, readonly string[]> = {
  "voting.rules_changed": ["voting.settings"],
};

/** Queue one delivery per enabled webhook of the row's event that subscribes to its action (or an action it also counts as). */
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
      : enabled.filter((h) => h.actions.includes("*") || [row.action, ...(ALSO_SUBSCRIBED_AS[row.action] ?? [])].some((a) => h.actions.includes(a)));
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

function privateV4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** An IPv6 address as its eight 16-bit words ("::" expanded, a dotted IPv4 tail and a zone id read), or null. */
function v6Words(ip: string): number[] | null {
  let x = ip.toLowerCase().replace(/%.*$/, "");
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (dotted) {
    if (!net.isIPv4(dotted[1]!)) return null;
    const [a, b, c, d] = dotted[1]!.split(".").map(Number) as [number, number, number, number];
    x = x.slice(0, -dotted[1]!.length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = x.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const words = [...head, ...Array<string>(fill).fill("0"), ...tail].map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN));
  return words.length === 8 && words.every((w) => !Number.isNaN(w)) ? words : null;
}

/**
 * Loopback, private, link-local, carrier-grade NAT, multicast and unspecified addresses, in IPv4 or IPv6. An IPv6
 * address that carries an IPv4 one (mapped ::ffff:a.b.c.d, the old compatible ::a.b.c.d, translated ::ffff:0:a.b.c.d,
 * NAT64 64:ff9b::a.b.c.d, 6to4 2002:aabb:ccdd::, Teredo) is judged by the IPv4 address it reaches, in whichever
 * notation it is written; local-use NAT64 (64:ff9b:1::/48), site-local, discard-only and documentation ranges count as
 * private too. Anything that is not an address at all counts as private.
 */
export function privateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return privateV4(a, b);
  }
  const w = net.isIPv6(ip.replace(/%.*$/, "")) ? v6Words(ip) : null;
  if (!w) return true;
  const v4 = (hi: number) => privateV4(hi >> 8, hi & 0xff);
  const zero = (from: number, to: number) => w.slice(from, to).every((n) => n === 0);
  if (zero(0, 5) && (w[5] === 0xffff || w[5] === 0)) return zero(0, 8) || v4(w[6]!); // ::, ::1, mapped, compatible
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return v4(w[6]!); // translated
  if (w[0] === 0x64 && w[1] === 0xff9b) return w[2] === 1 || v4(w[6]!); // NAT64, and local-use NAT64 as a whole
  if (w[0] === 0x2002) return v4(w[1]!); // 6to4
  if (w[0] === 0x2001 && w[1] === 0) return v4(w[2]!) || v4(~w[6]! & 0xffff); // Teredo: its server, and its client (bits flipped)
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x100 && zero(1, 4)) return true; // discard-only
  return (w[0]! & 0xfe00) === 0xfc00 || (w[0]! & 0xffc0) === 0xfe80 || (w[0]! & 0xffc0) === 0xfec0 || (w[0]! & 0xff00) === 0xff00;
}

/**
 * Why a URL may not receive webhooks, or null when it may. Private and local targets
 * are refused (so an organizer cannot make the portal call the machines around it)
 * unless WEBHOOKS_ALLOW_PRIVATE=true, for a test receiver on the same host.
 */
/** A host name's addresses, as the system resolver gives them; tests hand in their own. */
export type Resolve = (host: string) => Promise<string[]>;
const systemResolve: Resolve = async (host) => (await dns.lookup(host, { all: true })).map((a) => a.address);

export async function targetProblem(url: string, opts: { forDelivery?: boolean; resolve?: Resolve } = {}): Promise<string | null> {
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
    addresses = net.isIP(host) ? [host] : await (opts.resolve ?? systemResolve)(host);
  } catch {
    // When a webhook is added a name that does not resolve yet (or an offline portal)
    // proves nothing either way; each delivery checks again and does not send.
    return opts.forDelivery ? "its host name does not resolve" : null;
  }
  return addresses.some(privateAddress) ? "it resolves to a private or local address" : null;
}

/** What a delivery sends: a POST of body with these headers. It answers the receiver's status and the start of its body. */
export type Send = (url: string, init: { body: string; headers: Record<string, string> }) => Promise<{ status: number; text: string }>;

/** How much of a receiver's answer is read (the log keeps its first 500 characters); the rest is never downloaded. */
export const ANSWER_BYTES = 2048;

/**
 * The connection's own name lookup: the addresses it is about to connect to are the ones checked. Checking a name
 * first and letting the request look it up again would let a DNS answer that changes in between (DNS rebinding) reach
 * a private address; here there is no second lookup to change.
 */
function checkedLookup(resolve: Resolve): net.LookupFunction {
  return (hostname, options, callback) => {
    const done = callback as (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;
    resolve(hostname)
      .then((found) => {
        const wanted = options.family === 4 || options.family === 6 ? found.filter((a) => net.isIP(a) === options.family) : found;
        if (!wanted.length) throw Object.assign(new Error(`its host name ${hostname} does not resolve`), { code: "ENOTFOUND" });
        if (!allowPrivate() && wanted.some(privateAddress)) {
          throw Object.assign(new Error("not sent: its host name resolved to a private or local address when connecting"), { code: "EPRIVATE" });
        }
        if (options.all) done(null, wanted.map((address) => ({ address, family: net.isIP(address) })));
        else done(null, wanted[0]!, net.isIP(wanted[0]!));
      })
      .catch((err: Error) => done(err, ""));
  };
}

/**
 * The portal's own sender: node:http(s) with the checked lookup above, no redirects followed, no compressed answers
 * asked for (so none is inflated), at most ANSWER_BYTES of the answer read before the connection is dropped, and
 * TIMEOUT_MS for the whole exchange.
 */
function guardedSend(resolve: Resolve): Send {
  return (url, init) =>
    new Promise((resolvePromise, reject) => {
      const u = new URL(url);
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const req = (u.protocol === "https:" ? https : http).request(
        u,
        {
          method: "POST",
          agent: false,
          lookup: checkedLookup(resolve),
          headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let read = 0;
          const finish = () =>
            settle(() => {
              res.destroy();
              resolvePromise({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).subarray(0, ANSWER_BYTES).toString("utf8") });
            });
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            read += chunk.length;
            if (read >= ANSWER_BYTES) finish();
          });
          res.on("end", finish);
          res.on("close", finish);
          res.on("error", finish);
        },
      );
      const timer = setTimeout(() => req.destroy(new Error(`no answer within ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
      req.on("error", (err) => settle(() => reject(err)));
      req.end(init.body);
    });
}

/** delivered: arrived; retrying: failed this time, tried again later; failed: failed for good. */
export type DeliveryOutcome = { attempted: number; delivered: number; retrying: number; failed: number };

/**
 * Send every due delivery once (oldest first); a failure is retried later, the last one is final. Each delivery is
 * claimed before it is sent, so two passes at once, or two portal processes on one database, do not both send it.
 */
export async function deliverDue(opts: { now?: Date; limit?: number; send?: Send; resolve?: Resolve } = {}): Promise<DeliveryOutcome> {
  const db = getDb();
  const resolve = opts.resolve ?? systemResolve;
  const send = opts.send ?? guardedSend(resolve);
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
    const problem = disabledAt ? "the webhook is turned off" : await targetProblem(url, { forDelivery: true, resolve });
    if (problem) {
      error = `not sent: ${problem}`;
    } else {
      const body = JSON.stringify(d.payload);
      try {
        const res = await send(url, {
          body,
          headers: {
            "content-type": "application/json",
            "user-agent": "dogfood-portal-webhooks/1",
            "dogfood-event": d.action,
            "dogfood-delivery": d.id,
            "dogfood-signature": signatureHeader(secret, body, Math.floor(now.getTime() / 1000)),
          },
        });
        status = res.status;
        text = res.text.slice(0, 500);
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
