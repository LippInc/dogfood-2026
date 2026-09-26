import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Actor } from "../authz";
import { toCsv, type Cell } from "../csv";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, projects, rubricCriteria, teams, tracks, users } from "../db/schema";
import { NotFoundError } from "../errors";
import { guardRead } from "../mutate";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { reviewsOf } from "./scores";

// Organizer exports: CSV at every stage, and always a header row, even before
// anything is scored or published (a platform you cannot leave is a trap).

type Exporter = (db: DbOrTx, event: EventRow) => string;

function scoresCsv(db: DbOrTx, event: EventRow): string {
  const criteria = db
    .select({ key: rubricCriteria.key })
    .from(rubricCriteria)
    .where(eq(rubricCriteria.eventId, event.id))
    .orderBy(asc(rubricCriteria.position))
    .all()
    .map((c) => c.key);
  const judges = db
    .selectDistinct({ id: users.id, name: users.name })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.judgeUserId))
    .where(eq(assignments.eventId, event.id))
    .orderBy(asc(users.id))
    .all();
  const rows: Cell[][] = [];
  for (const j of judges) {
    for (const r of reviewsOf(db, j.id).filter((x) => x.eventId === event.id)) {
      const value = new Map(r.items.map((i) => [i.key, i.value]));
      rows.push([
        r.projectId,
        r.projectTitle,
        r.teamName,
        r.trackName,
        j.id,
        j.name,
        ...criteria.map((k) => value.get(k) ?? null),
        r.total === null ? null : Math.round(r.total * 1000) / 1000,
        r.status,
        r.submittedAt,
        r.feedback,
      ]);
    }
  }
  rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[4]).localeCompare(String(b[4])));
  return toCsv(
    [
      "project_id",
      "project_title",
      "team",
      "track",
      "judge_id",
      "judge_name",
      ...criteria,
      "weighted_total",
      "status",
      "submitted_at",
      "feedback",
    ],
    rows,
  );
}

function projectsCsv(db: DbOrTx, event: EventRow): string {
  const reviews = sql<number>`(select count(*) from ${assignments} a where a.project_id = ${projects.id} and a.status = 'done')`;
  const rows = db
    .select({
      id: projects.id,
      title: projects.title,
      summary: projects.summary,
      teamId: teams.id,
      team: teams.name,
      track: tracks.name,
      status: projects.status,
      submittedAt: projects.submittedAt,
      repoUrl: projects.repoUrl,
      duplicateOf: projects.duplicateOf,
      reviews,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, and(eq(tracks.id, projects.trackId), eq(tracks.eventId, projects.eventId)))
    .where(eq(projects.eventId, event.id))
    .orderBy(asc(projects.id))
    .all();
  return toCsv(
    ["project_id", "title", "summary", "team_id", "team", "track", "status", "submitted_at", "repo_url", "duplicate_of", "finished_reviews"],
    rows.map((r) => [r.id, r.title, r.summary, r.teamId, r.team, r.track, r.status, r.submittedAt, r.repoUrl, r.duplicateOf, r.reviews]),
  );
}

const EXPORTS: Record<string, Exporter> = {
  "scores.csv": scoresCsv,
  "projects.csv": projectsCsv,
};

export const EXPORT_FILES = Object.keys(EXPORTS);

/** One organizer export. 404 unknown event, 401/403 from authorize, 404 unknown file. */
export function exportFile(actor: Actor | null, eventIdOrSlug: string, file: string): { filename: string; body: string } {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.export", { kind: "event", event: eventFacts(event) });
  const make = EXPORTS[file];
  if (!make) throw new NotFoundError(`Export ${file}`);
  return { filename: `${event.id}-${file}`, body: make(db, event) };
}
