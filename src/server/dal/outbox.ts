import "server-only";
import { desc, eq, isNull } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { outbox } from "../db/schema";
import { guardRead } from "../mutate";
import { eventFacts, requireEvent } from "./events";

// The outbox, read side: what the portal mailed or tried to mail (nothing is recorded while email is off). An
// event's messages are for its organizers (and administrators); portal messages (password resets,
// administrator setup) for administrators only. Refused reads answer 401 or 403 and a 403 is
// audited, as on every other organizer page.

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

const LIMIT = 100;

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

/** One event's messages, newest first, the last 100. */
export function listOutbox(actor: Actor | null, eventIdOrSlug: string): OutboxView[] {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return db.select(view).from(outbox).where(eq(outbox.eventId, event.id)).orderBy(desc(outbox.createdAt), desc(outbox.id)).limit(LIMIT).all();
}

/** The portal's own messages (no event), newest first, the last 100: administrators only. */
export function listPortalOutbox(actor: Actor | null): OutboxView[] {
  guardRead(actor, "portal.accounts", { kind: "platform" });
  return getDb().select(view).from(outbox).where(isNull(outbox.eventId)).orderBy(desc(outbox.createdAt), desc(outbox.id)).limit(LIMIT).all();
}
