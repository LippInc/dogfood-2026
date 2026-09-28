import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { FIELD_MODES, PROJECT_FIELDS, withDefaults, type FieldModes } from "@/lib/project-fields";
import type { DbOrTx } from "../db/client";
import { projectFields, projects, teams, tracks } from "../db/schema";

// Reading the organizer's choice of what a team fills in (the choice is saved in organize.ts,
// with the other settings). Every place that takes or shows a project reads it from here.

/** The body of PUT /api/events/{event}/project-fields: any of the fields, each with its mode; a field left out keeps its mode. */
export const ProjectFieldsInput = z.partialRecord(z.enum(PROJECT_FIELDS), z.enum(FIELD_MODES));

export function trackCount(db: DbOrTx, eventId: string): number {
  return db.select({ n: sql<number>`count(*)` }).from(tracks).where(eq(tracks.eventId, eventId)).get()?.n ?? 0;
}

/**
 * The modes in force for one event: the stored choices over the defaults. A hidden track holds
 * only while the event has one track (the team gets it); if a second track was added since, the
 * track is asked again, so no project is ever left without one.
 */
export function fieldModes(db: DbOrTx, eventId: string): FieldModes {
  const rows = db.select({ field: projectFields.field, mode: projectFields.mode }).from(projectFields).where(eq(projectFields.eventId, eventId)).all();
  const modes = withDefaults(Object.fromEntries(rows.map((r) => [r.field, r.mode])));
  if (modes.trackId !== "required" && trackCount(db, eventId) !== 1) modes.trackId = "required";
  return modes;
}


/**
 * The name a project is shown under, as a column for a select over projects: its title, or its
 * team's name while the organizer hides the title. Hiding keeps what the team typed (the stored
 * title), and it shows again when the field is asked again, as with every hidden field. Every
 * read that shows a project's name uses this; saves, duplicate matching and the event's own JSON
 * export read the stored title.
 */
export const shownTitle = () =>
  sql<string>`(case when exists (select 1 from ${projectFields} pf where pf.event_id = ${projects.eventId} and pf.field = 'title' and pf.mode = 'hidden') then coalesce(nullif(trim((select t.name from ${teams} t where t.id = ${projects.teamId})), ''), 'Untitled project') else ${projects.title} end)`;
