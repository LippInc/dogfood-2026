import "server-only";
import { and, desc, eq, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { outbox } from "../db/schema";
import { ValidationError } from "../errors";
import { guardRead } from "../mutate";
import { eventFacts, requireEvent } from "./events";

// The outbox, read side: what the portal mailed or tried to mail (nothing is recorded while email is off). An
// event's messages are for its organizers (and administrators); portal messages (password resets,
// administrator setup) for administrators only. Refused reads answer 401 or 403 and a 403 is
// audited, as on every other organizer page. It is read a page at a time, newest first; each page
// names the message the next (older) one starts after, so new mail arriving meanwhile shifts nothing.

export type OutboxView = {
  id: string;
  kind: string;
  toEmail: string;
  subject: string;
  body: string;
  status: string;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};

/** One page of messages, newest first; next: the id to pass as `before` for the older page, or null at the end. Counts are over every message. */
export type OutboxPage = {
  messages: OutboxView[];
  next: string | null;
  counts: { total: number; sent: number; failed: number };
};

export const OUTBOX_PAGE = 100;
export const OUTBOX_PAGE_MAX = 500;

export type OutboxPaging = { before?: string | null; limit?: number | string | null };

const view = {
  id: outbox.id,
  kind: outbox.kind,
  toEmail: outbox.toEmail,
  subject: outbox.subject,
  body: outbox.body,
  status: outbox.status,
  error: outbox.error,
  createdAt: outbox.createdAt,
  sentAt: outbox.sentAt,
};

function pageSize(limit: OutboxPaging["limit"]): number {
  if (limit === undefined || limit === null || limit === "") return OUTBOX_PAGE;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > OUTBOX_PAGE_MAX) {
    throw new ValidationError(`limit is a whole number from 1 to ${OUTBOX_PAGE_MAX}.`, { limit: [`1 to ${OUTBOX_PAGE_MAX}`] });
  }
  return n;
}

function readPage(scope: SQL | undefined, paging: OutboxPaging): OutboxPage {
  const db = getDb();
  const limit = pageSize(paging.limit);
  let after: SQL | undefined;
  if (paging.before) {
    // the cursor is a message of the same list: another event's (or a made-up) id is refused, not ignored
    const at = db.select({ createdAt: outbox.createdAt, id: outbox.id }).from(outbox).where(and(scope, eq(outbox.id, paging.before))).get();
    if (!at) throw new ValidationError("before names no message in this outbox.", { before: ["no such message here"] });
    after = or(lt(outbox.createdAt, at.createdAt), and(eq(outbox.createdAt, at.createdAt), lt(outbox.id, at.id)));
  }
  const rows = db
    .select(view)
    .from(outbox)
    .where(and(scope, after))
    .orderBy(desc(outbox.createdAt), desc(outbox.id))
    .limit(limit + 1)
    .all();
  const messages = rows.slice(0, limit);
  const counts = db
    .select({
      total: sql<number>`count(*)`,
      sent: sql<number>`coalesce(sum(${outbox.status} = 'sent'), 0)`,
      failed: sql<number>`coalesce(sum(${outbox.status} = 'failed'), 0)`,
    })
    .from(outbox)
    .where(scope)
    .get()!;
  return { messages, next: rows.length > limit ? messages.at(-1)!.id : null, counts };
}

/** One event's messages, a page at a time, newest first (100 a page unless `limit` says up to 500). */
export function listOutbox(actor: Actor | null, eventIdOrSlug: string, paging: OutboxPaging = {}): OutboxPage {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return readPage(eq(outbox.eventId, event.id), paging);
}

/** The portal's own messages (no event), a page at a time, newest first: administrators only. */
export function listPortalOutbox(actor: Actor | null, paging: OutboxPaging = {}): OutboxPage {
  guardRead(actor, "portal.accounts", { kind: "platform" });
  return readPage(isNull(outbox.eventId), paging);
}
