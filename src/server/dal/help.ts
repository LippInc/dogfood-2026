import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import type { HelpRole, HelpViewer } from "@/lib/help";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { events } from "../db/schema";

/** Which roles rank first in Help, and whose event its links point at when no event is in view. */
const ROLE_ORDER: HelpRole[] = ["organizer", "judge", "participant", "admin"];

/**
 * Who is asking the Help panel, so it can rank what they can do first and suggest questions for their role. It
 * reads only the person's own session facts and public event names, so there is nothing to authorize (like
 * actorNav): on an event's pages the roles are those in that event (an administrator counts as its organizer, as
 * the top bar does), elsewhere every role they hold. The links point at the event in view, else the person's own
 * event (organizing first), else the portal's first event, else nowhere.
 */
export function helpViewer(actor: Actor | null, inView?: { slug: string; name: string } | null): HelpViewer {
  const db = getDb();
  const inViewId = inView ? db.select({ id: events.id }).from(events).where(eq(events.slug, inView.slug)).get()?.id : undefined;
  const held = actor ? (inViewId ? actor.roles.filter((r) => r.eventId === inViewId) : actor.roles) : [];
  const roles = new Set<HelpRole>(held.map((r) => r.role));
  if (actor?.isAdmin) {
    roles.add("admin");
    if (inViewId) roles.add("organizer");
  }
  let event = inView ? { slug: inView.slug, name: inView.name } : null;
  if (!event && actor && actor.roles.length) {
    const own = [...actor.roles].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
    const found = db
      .select({ id: events.id, slug: events.slug, name: events.name })
      .from(events)
      .where(inArray(events.id, [...new Set(own.map((r) => r.eventId))]))
      .all();
    const first = own.map((r) => found.find((e) => e.id === r.eventId)).find(Boolean);
    if (first) event = { slug: first.slug, name: first.name };
  }
  if (!event) {
    const first = db.select({ slug: events.slug, name: events.name }).from(events).orderBy(asc(events.createdAt), asc(events.id)).limit(1).get();
    if (first) event = first;
  }
  return { signedIn: Boolean(actor), roles: ROLE_ORDER.filter((r) => roles.has(r)), event };
}
