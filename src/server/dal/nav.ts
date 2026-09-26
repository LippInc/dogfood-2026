import "server-only";
import { inArray } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { events } from "../db/schema";

export type NavLink = { href: string; label: string };

/** Where a signed-in person can go from the top bar, derived from their roles. */
export function actorNav(actor: Actor | null): NavLink[] {
  if (!actor) return [];
  const eventIds = [...new Set(actor.roles.map((r) => r.eventId))];
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
  for (const r of actor.roles) {
    const slug = slugs.get(r.eventId);
    if (!slug) continue;
    if (r.role === "judge") links.push({ href: `/judge/${slug}`, label: "Judge console" });
    if (r.role === "organizer") links.push({ href: `/organize/${slug}`, label: "Organizer" });
    if (r.role === "participant") links.push({ href: `/events/${slug}/my-project`, label: "My project" });
  }
  return links;
}
