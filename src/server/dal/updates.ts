import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type Tx } from "../db/client";
import { eventUpdates, teamMembers, users } from "../db/schema";
import { NotFoundError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent } from "./events";
import { emailIsOn, mailEventUpdate, type MailReport } from "./mailing";
import { parse } from "./parse";

// The organizers' updates to an event ("deadline extended", "judging has started", "winners at 18:00"). An update is plain text: the pages print it as text (React escapes it), keep its
// line breaks and never read it as HTML. Updates are news, not results, so they may be posted, edited and removed
// after publishing too; each of those is one audited write, and an edit or a removal keeps the old words in its
// audit row. With SMTP_URL set, a new update may also be mailed to the event's participants (every member of a
// team in it) through mailing.ts, which records each message in the outbox.

export const UPDATE_TITLE_MAX = 120;
export const UPDATE_BODY_MAX = 5_000;
/** How many updates the event's public pages show before "every update". */
export const UPDATES_SHOWN = 3;

/** Line endings as one kind, so a body typed on Windows and one sent by the API read and count the same. */
const oneLineEnding = (s: string) => s.replace(/\r\n?/g, "\n");
const title = z
  .string()
  .transform((s) => s.replace(/[\r\n]+/g, " ").trim())
  .pipe(z.string().min(1, "write a title").max(UPDATE_TITLE_MAX, `at most ${UPDATE_TITLE_MAX} characters`));
const body = z
  .string()
  .transform((s) => oneLineEnding(s).replace(/^\s*\n|\s+$/g, ""))
  .pipe(z.string().min(1, "write the update").max(UPDATE_BODY_MAX, `at most ${UPDATE_BODY_MAX.toLocaleString("en")} characters`));

export const UpdateInput = z.object({
  title,
  body,
  /** mail it to the event's participants too; only while SMTP_URL is set */
  email: z.boolean().optional().default(false),
});
export const UpdateEdit = z.object({ title, body });

export type UpdateView = { id: string; title: string; body: string; at: string; editedAt: string | null };

const view = (r: typeof eventUpdates.$inferSelect): UpdateView => ({ id: r.id, title: r.title, body: r.body, at: r.createdAt, editedAt: r.editedAt });

/** An event's updates, newest first; anyone may read them. limit: only the newest few, with the total. */
export function listUpdates(eventIdOrSlug: string, limit?: number): { updates: UpdateView[]; total: number } {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const rows = db.select().from(eventUpdates).where(eq(eventUpdates.eventId, event.id)).orderBy(desc(eventUpdates.createdAt), desc(eventUpdates.id)).all();
  return { updates: (limit === undefined ? rows : rows.slice(0, limit)).map(view), total: rows.length };
}

/** The addresses an update is mailed to: every member of a team in the event, once each, in order. */
function participantAddresses(db: Tx | ReturnType<typeof getDb>, eventId: string): string[] {
  return db
    .selectDistinct({ email: users.email })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.eventId, eventId))
    .orderBy(asc(users.email))
    .all()
    .map((r) => r.email);
}

/** For the organizer's form: whether email is on and how many people an update would go to. */
export function getUpdatesAdmin(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return { event, ...listUpdates(event.id), emailOn: emailIsOn(), recipients: participantAddresses(db, event.id).length };
}

/** The organizer question, asked (and a refusal audited) before a body is read: 401 and 403 come before 422. */
const guardWrite = (actor: Actor | null, eventIdOrSlug: string) =>
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(requireEvent(getDb(), eventIdOrSlug)) }, new Date(), "write");

const loadEvent = (eventIdOrSlug: string) => (tx: Tx) => ({ kind: "event" as const, event: eventFacts(requireEvent(tx, eventIdOrSlug)) });

/**
 * Post an update: one audited write. With email asked for and SMTP_URL set, it is then mailed to the event's
 * participants (mailing.ts records each message and its outcome with audited writes of its own); asked for with
 * email off, it is posted and the answer says nothing was mailed, and its audit row reads as a plain post.
 */
export async function postUpdate(actor: Actor | null, eventIdOrSlug: string, input: unknown): Promise<{ update: UpdateView; mail: MailReport | null }> {
  guardWrite(actor, eventIdOrSlug);
  const u = parse(UpdateInput, input);
  const at = new Date();
  const { update, eventId, to } = mutate({
    actor,
    action: "event.manage",
    load: loadEvent(eventIdOrSlug),
    now: at,
    run: (tx) => {
      const event = requireEvent(tx, eventIdOrSlug);
      const row = { id: newId("upd"), eventId: event.id, title: u.title, body: u.body, createdBy: actor!.userId, createdAt: at.toISOString(), editedAt: null };
      tx.insert(eventUpdates).values(row).run();
      // the people it will be mailed to, read in the same write: the audit row says "to be mailed" only when mail
      // will be tried for at least one person (email on and someone on a team), never on the box alone
      const to = u.email && emailIsOn() ? participantAddresses(tx, event.id) : [];
      return {
        result: { update: view(row), eventId: event.id, to },
        audit: { action: "update.post", eventId: event.id, targetType: "update", targetId: row.id, after: { title: u.title, body: u.body, ...(to.length ? { email: true } : {}) } },
      };
    },
  });
  if (!u.email) return { update, mail: null };
  return { update, mail: await mailEventUpdate(actor, eventId, { title: update.title, body: update.body }, to) };
}

function requireUpdate(tx: Tx, eventId: string, id: string) {
  const row = tx.select().from(eventUpdates).where(and(eq(eventUpdates.id, id), eq(eventUpdates.eventId, eventId))).get();
  if (!row) throw new NotFoundError("Update");
  return row;
}

/** Change an update's words: one audited write that keeps the old words. Nothing is mailed again. */
export function editUpdate(actor: Actor | null, eventIdOrSlug: string, updateId: string, input: unknown): UpdateView {
  guardWrite(actor, eventIdOrSlug);
  const u = parse(UpdateEdit, input);
  const at = new Date();
  return mutate({
    actor,
    action: "event.manage",
    load: loadEvent(eventIdOrSlug),
    now: at,
    run: (tx) => {
      const event = requireEvent(tx, eventIdOrSlug);
      const old = requireUpdate(tx, event.id, updateId);
      if (old.title === u.title && old.body === u.body) return { result: view(old), audit: null };
      tx.update(eventUpdates).set({ title: u.title, body: u.body, editedAt: at.toISOString() }).where(eq(eventUpdates.id, old.id)).run();
      return {
        result: { ...view(old), title: u.title, body: u.body, editedAt: at.toISOString() },
        audit: { action: "update.edit", eventId: event.id, targetType: "update", targetId: old.id, before: { title: old.title, body: old.body }, after: { title: u.title, body: u.body } },
      };
    },
  });
}

/** Take an update off the event's pages: one audited write that keeps its words in the audit row. */
export function removeUpdate(actor: Actor | null, eventIdOrSlug: string, updateId: string): { removed: string } {
  return mutate({
    actor,
    action: "event.manage",
    load: loadEvent(eventIdOrSlug),
    run: (tx) => {
      const event = requireEvent(tx, eventIdOrSlug);
      const old = requireUpdate(tx, event.id, updateId);
      tx.delete(eventUpdates).where(eq(eventUpdates.id, old.id)).run();
      return {
        result: { removed: old.id },
        audit: { action: "update.remove", eventId: event.id, targetType: "update", targetId: old.id, before: { title: old.title, body: old.body, at: old.createdAt } },
      };
    },
  });
}
