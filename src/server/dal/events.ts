import "server-only";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { EventFacts } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { events, projects, teams, tracks, userRoles } from "../db/schema";
import { NotFoundError } from "../errors";

export type EventRow = typeof events.$inferSelect;

export function eventFacts(e: EventRow): EventFacts {
  return {
    id: e.id,
    submissionsOpenAt: e.submissionsOpenAt,
    submissionsCloseAt: e.submissionsCloseAt,
    resultsPublishedAt: e.resultsPublishedAt,
  };
}

/** An event by id or by slug (public URLs use the slug, the API uses the id). */
export function findEvent(db: DbOrTx, idOrSlug: string): EventRow | undefined {
  return db
    .select()
    .from(events)
    .where(or(eq(events.slug, idOrSlug), eq(events.id, idOrSlug)))
    .get();
}

export function requireEvent(db: DbOrTx, idOrSlug: string): EventRow {
  const e = findEvent(db, idOrSlug);
  if (!e) throw new NotFoundError("Event");
  return e;
}

export type PublicEvent = Pick<
  EventRow,
  "id" | "slug" | "name" | "description" | "submissionsOpenAt" | "submissionsCloseAt" | "judgingCloseAt" | "resultsPublishedAt"
>;

const publicEventColumns = {
  id: events.id,
  slug: events.slug,
  name: events.name,
  description: events.description,
  submissionsOpenAt: events.submissionsOpenAt,
  submissionsCloseAt: events.submissionsCloseAt,
  judgingCloseAt: events.judgingCloseAt,
  resultsPublishedAt: events.resultsPublishedAt,
};

export function listEvents(): PublicEvent[] {
  return getDb().select(publicEventColumns).from(events).orderBy(asc(events.createdAt), asc(events.id)).all();
}

export type GalleryProject = {
  id: string;
  title: string;
  summary: string;
  teamName: string;
  trackId: string;
  trackName: string;
  submittedAt: string | null;
};

export type Gallery = {
  event: PublicEvent;
  tracks: { id: string; name: string; count: number }[];
  projects: GalleryProject[];
  counts: { projects: number; teams: number; tracks: number; judges: number };
};

/**
 * Everything the public gallery shows: every submitted project of the event (a
 * project merged away as a duplicate is left out), with team and track names.
 * Public: no actor needed. Scores never appear here.
 */
export function getGallery(idOrSlug: string): Gallery {
  const db = getDb();
  const found = findEvent(db, idOrSlug);
  if (!found) throw new NotFoundError("Event");
  const event: PublicEvent = {
    id: found.id,
    slug: found.slug,
    name: found.name,
    description: found.description,
    submissionsOpenAt: found.submissionsOpenAt,
    submissionsCloseAt: found.submissionsCloseAt,
    judgingCloseAt: found.judgingCloseAt,
    resultsPublishedAt: found.resultsPublishedAt,
  };

  const rows = db
    .select({
      id: projects.id,
      title: projects.title,
      summary: projects.summary,
      teamName: teams.name,
      trackId: tracks.id,
      trackName: tracks.name,
      submittedAt: projects.submittedAt,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.eventId, event.id), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .orderBy(asc(projects.id))
    .all();

  const trackRows = db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, event.id))
    .orderBy(asc(tracks.position), asc(tracks.id))
    .all();
  const perTrack = new Map<string, number>();
  for (const p of rows) perTrack.set(p.trackId, (perTrack.get(p.trackId) ?? 0) + 1);

  const judges = db
    .select({ n: sql<number>`count(distinct ${userRoles.userId})` })
    .from(userRoles)
    .where(and(eq(userRoles.eventId, event.id), eq(userRoles.role, "judge")))
    .get();
  const teamCount = db
    .select({ n: sql<number>`count(*)` })
    .from(teams)
    .where(eq(teams.eventId, event.id))
    .get();

  return {
    event,
    tracks: trackRows.map((t) => ({ ...t, count: perTrack.get(t.id) ?? 0 })),
    projects: rows,
    counts: {
      projects: rows.length,
      teams: teamCount?.n ?? 0,
      tracks: trackRows.length,
      judges: judges?.n ?? 0,
    },
  };
}
