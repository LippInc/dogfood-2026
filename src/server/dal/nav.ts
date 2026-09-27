import "server-only";
import { inArray } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { events } from "../db/schema";

export type NavLink = { href: string; label: string };

/**
 * Where a signed-in person can go from the top bar, derived from their roles. An
 * event's own pages pass its id: the bar then lists only the roles in that event,
 * so someone on teams in two events does not see "My project" twice.
 */
export function actorNav(actor: Actor | null, eventId?: string): NavLink[] {
  if (!actor) return [];
  const roles = eventId ? actor.roles.filter((r) => r.eventId === eventId) : actor.roles;
  const eventIds = [...new Set(roles.map((r) => r.eventId))];
  if (eventIds.length === 0) return [];
  const slugs = new Map(
    getDb()
      .select({ id: events.id, slug: events.slug })
      .from(events)
      .where(inArray(events.id, eventIds))
      .all()
      .map((e) => [e.id, e.slug]),
  );
  const links: NavLink[] = [];
  for (const r of roles) {
    const slug = slugs.get(r.eventId);
    if (!slug) continue;
    if (r.role === "judge") links.push({ href: `/judge/${slug}`, label: "Judge console" });
    if (r.role === "organizer") links.push({ href: `/organize/${slug}`, label: "Organizer" });
    if (r.role === "participant") links.push({ href: `/events/${slug}/my-project`, label: "My project" });
  }
  return links;
}
