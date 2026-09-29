import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { compareNames } from "@/lib/names";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { teamMembers, userRoles, users } from "../db/schema";
import { ConflictError, HttpError, NotFoundError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { parse } from "./parse";

// Co-organizers. The account that creates or imports an event organizes it; an
// organizer adds others by the email of their account (they sign up first: adding
// an organizer mails nothing) and can remove any organizer but the last. Audited.

export type Organizer = { userId: string; name: string; email: string; since: string };

export const OrganizerInput = z.object({ email: z.string().trim().toLowerCase().email("that is not an email address").max(254) });

function organizersOf(db: DbOrTx, eventId: string): Organizer[] {
  return db
    .select({ userId: users.id, name: users.name, email: users.email, since: userRoles.createdAt })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "organizer")))
    .orderBy(asc(userRoles.createdAt), asc(users.name))
    .all()
    // oldest first; organizers added in the same instant by name, the way a reader expects
    .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : compareNames(a.name, b.name)));
}

export function listOrganizers(actor: Actor | null, eventIdOrSlug: string): Organizer[] {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return organizersOf(db, event.id);
}

/** The events other than this one where the account has a role or a team seat. */
function otherEventsOf(db: DbOrTx, userId: string, eventId: string): string[] {
  const ids = new Set([
    ...db.select({ eventId: userRoles.eventId }).from(userRoles).where(eq(userRoles.userId, userId)).all().map((r) => r.eventId),
    ...db.select({ eventId: teamMembers.eventId }).from(teamMembers).where(eq(teamMembers.userId, userId)).all().map((r) => r.eventId),
  ]);
  ids.delete(eventId);
  return [...ids];
}

/** Make an existing account an organizer of the event; adding one twice changes nothing. */
export function addOrganizer(actor: Actor | null, eventIdOrSlug: string, body: unknown): { userId: string; added: boolean } {
  let event: EventRow;
  return mutate<{ userId: string; added: boolean }>({
    actor,
    action: "organizer.add",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      // read without throwing: a malformed body is answered 422 only after the permission check
      const email = OrganizerInput.safeParse(body).data?.email;
      const candidate = email ? tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get() : undefined;
      return { kind: "organizer_candidate", event: eventFacts(event), otherEventIds: candidate ? otherEventsOf(tx, candidate.id, event.id) : [] };
    },
    run: (tx) => {
      const { email } = parse(OrganizerInput, body);
      const user = tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email)).get();
      if (!user) throw new HttpError(404, "no_account", "No account uses that address. Ask them to sign up first, then add them.");
      const inserted = tx
        .insert(userRoles)
        .values({ userId: user.id, eventId: event.id, role: "organizer", createdAt: new Date().toISOString() })
        .onConflictDoNothing()
        .run().changes;
      if (!inserted) return { result: { userId: user.id, added: false }, audit: null };
      return {
        result: { userId: user.id, added: true },
        audit: { action: "event.organizer_added", eventId: event.id, targetType: "user", targetId: user.id, after: { email } },
      };
    },
  });
}

/** Remove an organizer; the last one stays, so the event is never left without one. */
export function removeOrganizer(actor: Actor | null, eventIdOrSlug: string, userId: string): { removed: true } {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      const all = organizersOf(tx, event.id);
      const one = all.find((o) => o.userId === userId);
      if (!one) throw new NotFoundError("Organizer");
      if (all.length === 1) throw new ConflictError("last_organizer", "An event keeps at least one organizer. Add another before removing this one.");
      tx.delete(userRoles)
        .where(and(eq(userRoles.userId, userId), eq(userRoles.eventId, event.id), eq(userRoles.role, "organizer")))
        .run();
      return {
        result: { removed: true as const },
        audit: { action: "event.organizer_removed", eventId: event.id, targetType: "user", targetId: userId, before: { email: one.email } },
      };
    },
  });
}
