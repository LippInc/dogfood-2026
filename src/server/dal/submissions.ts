import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb } from "../db/client";
import { assignments, projects, teamMembers, teams, tracks } from "../db/schema";
import { guardRead } from "../mutate";
import { eventFacts, requireEvent } from "./events";
import { decisions } from "./normalization";

// The organizer's list of every project, drafts included, with its review progress.

export type SubmissionRow = {
  id: string;
  title: string;
  status: "draft" | "submitted";
  trackName: string;
  teamName: string;
  members: number;
  submittedAt: string | null;
  duplicateOf: string | null;
  /** a copy in a duplicate decision the organizer has not made yet */
  suspectedDuplicate: boolean;
  /** copies the organizer merged into this one */
  mergedIn: string[];
  reviewsDone: number;
  reviewsAssigned: number;
  repoUrl: string | null;
};

export function getSubmissions(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const rows = db
    .select({
      id: projects.id,
      title: projects.title,
      status: projects.status,
      trackName: tracks.name,
      teamId: teams.id,
      teamName: teams.name,
      members: sql<number>`(select count(*) from ${teamMembers} m where m.team_id = ${teams.id})`,
      submittedAt: projects.submittedAt,
      duplicateOf: projects.duplicateOf,
      repoUrl: projects.repoUrl,
      done: sql<number>`(select count(*) from ${assignments} a where a.project_id = ${projects.id} and a.status = 'done')`,
      assigned: sql<number>`(select count(*) from ${assignments} a where a.project_id = ${projects.id} and a.status != 'recused')`,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.eventId, event.id)))
    .orderBy(asc(tracks.position), asc(projects.title))
    .all();
  // the same duplicate groups as the overview's decisions, so the two pages never disagree
  const dupes = decisions(db, event).flatMap((d) => (d.kind === "duplicate" ? [d] : []));
  const open = new Set(dupes.filter((d) => d.resolved === null).flatMap((d) => d.copies.map((c) => c.id)));
  const mergedIn = new Map<string, string[]>();
  for (const d of dupes) for (const c of d.copies) if (c.duplicateOf) mergedIn.set(c.duplicateOf, [...(mergedIn.get(c.duplicateOf) ?? []), c.id]);
  const list: SubmissionRow[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    trackName: r.trackName,
    teamName: r.teamName,
    members: r.members,
    submittedAt: r.submittedAt,
    duplicateOf: r.duplicateOf,
    suspectedDuplicate: open.has(r.id),
    mergedIn: mergedIn.get(r.id) ?? [],
    reviewsDone: r.done,
    reviewsAssigned: r.assigned,
    repoUrl: r.repoUrl,
  }));
  return {
    event,
    rows: list,
    submitted: list.filter((r) => r.status === "submitted").length,
    drafts: list.filter((r) => r.status === "draft").length,
  };
}
