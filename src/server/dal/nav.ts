import "server-only";
import { inArray } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { events } from "../db/schema";

/** event: the event's name, for lists that span events (the home page) */
export type NavLink = { href: string; label: string; event: string };

/**
 * Where a signed-in person can go from the top bar, derived from their roles. An
 * event's own pages pass its id: the bar then lists only the roles in that event,
 * so someone on teams in two events does not see "My project" twice.
 */
export function actorNav(actor: Actor | null, eventId?: string): NavLink[] {
  if (!actor) return [];
  const own = eventId ? actor.roles.filter((r) => r.eventId === eventId) : actor.roles;
  // An administrator runs every event (runsEvent in authz.ts): on an event's own pages its organizer link shows for them too.
  const roles: { eventId: string; role: string }[] =
    eventId && actor.isAdmin && !own.some((r) => r.role === "organizer") ? [...own, { eventId, role: "organizer" }] : own;
  const eventIds = [...new Set(roles.map((r) => r.eventId))];
  if (eventIds.length === 0) return [];
  const byId = new Map(
    getDb()
      .select({ id: events.id, slug: events.slug, name: events.name })
      .from(events)
      .where(inArray(events.id, eventIds))
      .all()
      .map((e) => [e.id, e]),
  );
  const links: NavLink[] = [];
  for (const r of roles) {
    const e = byId.get(r.eventId);
    if (!e) continue;
    if (r.role === "judge") links.push({ href: `/judge/${e.slug}`, label: "Judge console", event: e.name });
    if (r.role === "organizer") links.push({ href: `/organize/${e.slug}`, label: "Organizer", event: e.name });
    if (r.role === "participant") links.push({ href: `/events/${e.slug}/my-project`, label: "My project", event: e.name });
  }
  return links;
}
