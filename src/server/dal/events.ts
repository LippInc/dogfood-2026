import "server-only";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { Actor, EventFacts } from "../authz";
import { getDb, type DbOrTx, type Tx } from "../db/client";
import { events, prizes, projects, rubricCriteria, teams, tracks, userRoles } from "../db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { mutate, type MutationAudit } from "../mutate";
import { withoutHidden, type FieldModes } from "@/lib/project-fields";
import { hasTag, projectMatches, searchText, searchWords } from "@/lib/search";
import { fieldModes, trackCount, shownTitle } from "./project-fields";

export type EventRow = typeof events.$inferSelect;

export function eventFacts(e: EventRow): EventFacts {
  return {
    id: e.id,
    submissionsOpenAt: e.submissionsOpenAt,
    submissionsCloseAt: e.submissionsCloseAt,
    resultsPublishedAt: e.resultsPublishedAt,
    judgingCloseAt: e.judgingCloseAt,
    votingOpenAt: e.votingOpenAt,
    votingCloseAt: e.votingCloseAt,
  };
}

/**
 * The event as a participant's own view returns it over the API: every date, but of the
 * settings only the accent colour and the team size. The rest of the settings (which
 * projects the organizer accepted as under-reviewed, the vote link's hash, the
 * published run) is organizer business.
 */
export function participantEventView(e: EventRow) {
  const { settings, ...rest } = e;
  return { ...rest, settings: { accent: settings.accent, maxTeamSize: settings.maxTeamSize } };
}
export type ParticipantEventView = ReturnType<typeof participantEventView>;

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

/**
 * An organizer's audited change to one event: the event is loaded and event.manage decided inside the
 * transaction (a refusal is recorded like every 403), then `run` makes the change with the event as loaded,
 * and its audit row commits with it (mutate). Synchronous, like every write.
 */
export function organizerMutation<T>(actor: Actor | null, eventIdOrSlug: string, run: (tx: Tx, event: EventRow) => { result: T; audit: MutationAudit }): T {
  let event: EventRow;
  return mutate<T>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => run(tx, event),
  });
}

export type PublicEvent = Pick<
  EventRow,
  | "id"
  | "slug"
  | "name"
  | "description"
  | "submissionsOpenAt"
  | "submissionsCloseAt"
  | "judgingCloseAt"
  | "resultsPublishedAt"
  | "votingOpenAt"
  | "votingCloseAt"
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
  votingOpenAt: events.votingOpenAt,
  votingCloseAt: events.votingCloseAt,
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
  thumbnailUrl: string | null;
  tags: string[];
  /** only when asked for (getGallery's withText): the write-up as the search reads it (searchText), empty while hidden */
  text?: string;
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
 * Public: no actor needed. Scores never appear here. withText adds each project's write-up in the form the search
 * reads (searchText), for the gallery page and its search; a field the organizers hide gives an empty one.
 */
export function getGallery(idOrSlug: string, opts: { withText?: boolean } = {}): Gallery {
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
    votingOpenAt: found.votingOpenAt,
    votingCloseAt: found.votingCloseAt,
    judgingCloseAt: found.judgingCloseAt,
    resultsPublishedAt: found.resultsPublishedAt,
  };

  const rows = db
    .select({
      id: projects.id,
      title: shownTitle(),
      summary: projects.summary,
      teamName: teams.name,
      trackId: tracks.id,
      trackName: tracks.name,
      submittedAt: projects.submittedAt,
      thumbnailUrl: projects.thumbnailUrl,
      tags: projects.tags,
      // read only for the search (withText): the home page and the other pages that count projects skip it
      description: opts.withText ? projects.description : sql<string>`''`,
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

  // what the organizer does not ask for is not shown, even where a team filled it in before
  const modes = fieldModes(db, event.id);
  return {
    event,
    tracks: trackRows.map((t) => ({ ...t, count: perTrack.get(t.id) ?? 0 })),
    projects: rows.map((row) => {
      const { description, ...p } = withoutHidden(row, modes);
      return opts.withText ? { ...p, text: searchText(description) } : p;
    }),
    counts: {
      projects: rows.length,
      teams: teamCount?.n ?? 0,
      tracks: trackRows.length,
      judges: judges?.n ?? 0,
    },
  };
}

/** The longest search a gallery takes: a sentence, not a document. */
export const MAX_SEARCH = 200;

/** The longest tag the gallery's tag filter takes. */
export const MAX_TAG = 60;

/**
 * The gallery narrowed as its search box, track buttons and tag filter narrow it (src/lib/search.ts): q's words must
 * all appear in a project's title, summary, write-up, team, track, id or tags, ignoring case and accents; track keeps
 * one track's projects; tag keeps the projects carrying that tag (case and accents ignored; a tag no project carries
 * keeps none). Only what the gallery shows is searched, so a field the organizers hide finds nothing. Public, like the
 * gallery.
 */
export function searchGallery(idOrSlug: string, filter: { q?: string | null; track?: string | null; tag?: string | null }): Gallery {
  const gallery = getGallery(idOrSlug, { withText: true });
  const q = filter.q ?? "";
  if (q.length > MAX_SEARCH) throw new ValidationError(`A search is at most ${MAX_SEARCH} characters.`, { q: [`at most ${MAX_SEARCH} characters`] });
  const tag = filter.tag?.trim() || null;
  if (tag && tag.length > MAX_TAG) throw new ValidationError(`A tag is at most ${MAX_TAG} characters.`, { tag: [`at most ${MAX_TAG} characters`] });
  const track = filter.track || null;
  if (track && !gallery.tracks.some((t) => t.id === track)) {
    throw new ValidationError(`This event has no track ${track}.`, { track: [`not one of ${gallery.tracks.map((t) => t.id).join(", ")}`] });
  }
  const words = searchWords(q);
  return {
    ...gallery,
    projects: gallery.projects
      .filter((p) => (!track || p.trackId === track) && hasTag(p, tag) && projectMatches(p, words))
      // the write-up's word list is the search's working copy, not part of the answer
      .map(({ text: _text, ...p }) => p),
  };
}

export type About = {
  event: PublicEvent;
  tracks: { id: string; name: string; count: number }[];
  prizes: { id: string; name: string; description: string }[];
  rubric: { key: string; label: string; prompt: string; weight: number; scaleMin: number; scaleMax: number }[];
};

/** The event's public facts: dates, tracks, prizes and how projects are judged. */
export function getAbout(idOrSlug: string): About {
  const gallery = getGallery(idOrSlug);
  const db = getDb();
  const id = gallery.event.id;
  return {
    event: gallery.event,
    tracks: gallery.tracks,
    prizes: db
      .select({ id: prizes.id, name: prizes.name, description: prizes.description })
      .from(prizes)
      .where(eq(prizes.eventId, id))
      .orderBy(asc(prizes.position))
      .all(),
    rubric: db
      .select({
        key: rubricCriteria.key,
        label: rubricCriteria.label,
        prompt: rubricCriteria.prompt,
        weight: rubricCriteria.weight,
        scaleMin: rubricCriteria.scaleMin,
        scaleMax: rubricCriteria.scaleMax,
      })
      .from(rubricCriteria)
      .where(eq(rubricCriteria.eventId, id))
      .orderBy(asc(rubricCriteria.position))
      .all(),
  };
}

/** An event's id and slug, for routes that key cookies by id. Public. */
export function eventRef(idOrSlug: string): { id: string; slug: string } {
  const e = requireEvent(getDb(), idOrSlug);
  return { id: e.id, slug: e.slug };
}

/**
 * What one event asks teams for each built-in field, and how many tracks it has. Public, like the
 * About page: it is the shape of the project form, and the gallery shows its effect anyway.
 */
export function getProjectFields(idOrSlug: string): { event: { id: string; slug: string }; fields: FieldModes; tracks: number } {
  const db = getDb();
  const e = requireEvent(db, idOrSlug);
  return { event: { id: e.id, slug: e.slug }, fields: fieldModes(db, e.id), tracks: trackCount(db, e.id) };
}
