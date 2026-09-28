import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../authz";
import { toCsv, type Cell } from "../csv";
import { getDb, type DbOrTx } from "../db/client";
import {
  comparisons,
  assignmentRuns,
  assignments,
  customAnswers,
  customQuestions,
  judgeOverrides,
  judgeTracks,
  normalizationRuns,
  prizes,
  projects,
  rubricCriteria,
  scoreComments,
  scoreItems,
  scores,
  teamMembers,
  teams,
  tracks,
  userRoles,
  users,
} from "../db/schema";
import { NotFoundError } from "../errors";
import { guardRead } from "../mutate";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { auditCsv } from "./audit-log";
import { computeNormalization } from "./normalization";
import { issuer } from "./records";
import { reviewsOf } from "./scores";
import { changedFromDefaults } from "@/lib/project-fields";
import { fieldModes, shownTitle } from "./project-fields";

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
      title: shownTitle(),
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

/** Every pairwise answer, taken back ones included (voided_at set), in the order given. */
function comparisonsCsv(db: DbOrTx, event: EventRow): string {
  const rows = db
    .select({
      id: comparisons.id,
      at: comparisons.createdAt,
      judgeId: comparisons.judgeUserId,
      judge: users.name,
      track: tracks.name,
      left: comparisons.leftProjectId,
      right: comparisons.rightProjectId,
      opened: comparisons.newProjectId,
      outcome: comparisons.outcome,
      voidedAt: comparisons.voidedAt,
    })
    .from(comparisons)
    .innerJoin(users, eq(users.id, comparisons.judgeUserId))
    .innerJoin(tracks, eq(tracks.id, comparisons.trackId))
    .where(eq(comparisons.eventId, event.id))
    .orderBy(asc(comparisons.createdAt), asc(comparisons.id))
    .all();
  return toCsv(
    ["comparison_id", "answered_at", "judge_id", "judge", "track", "left_project", "right_project", "just_opened", "answer", "taken_back_at"],
    rows.map((r) => [r.id, r.at, r.judgeId, r.judge, r.track, r.left, r.right, r.opened, r.outcome, r.voidedAt]),
  );
}

/** The engine's table: raw, raw without excluded judges, normalized, ranks and the move. */
function normalizedCsv(db: DbOrTx, event: EventRow): string {
  const n = computeNormalization(db, event);
  return toCsv(
    ["project_id", "title", "track", "team", "duplicate_of", "reviews_all", "reviews_counted", "raw_mean", "raw_mean_kept", "normalized", "normalized_se", "rank_raw", "rank_kept", "rank_normalized", "track_rank", "under_reviewed", "k", "beta2", "sigma2", "excluded_judges"],
    n.projects.map((p) => [
      p.id,
      p.title,
      p.trackName,
      p.teamName,
      p.duplicateOf ?? "",
      p.nAll,
      p.n,
      p.rawAll === null ? "" : p.rawAll.toFixed(4),
      p.rawKept === null ? "" : p.rawKept.toFixed(4),
      p.score === null ? "" : p.score.toFixed(4),
      p.se === null ? "" : p.se.toFixed(4),
      p.rankRaw ?? "",
      p.rankKept ?? "",
      p.rankNormalized ?? "",
      p.trackRank ?? "",
      p.underReviewed ? "yes" : "no",
      n.variance.k === null ? "" : n.variance.k.toFixed(3),
      n.variance.measured ? n.variance.beta2.toFixed(4) : "",
      n.variance.measured ? n.variance.sigma2.toFixed(4) : "",
      n.excluded.join(" "),
    ]),
  );
}

/** Everything about one event in one JSON document: leave with your data. */
function eventJson(db: DbOrTx, event: EventRow): string {
  const projectIds = db.select({ id: projects.id }).from(projects).where(eq(projects.eventId, event.id)).all().map((p) => p.id);
  const assignmentRows = db.select().from(assignments).where(eq(assignments.eventId, event.id)).all();
  const scoreRows = assignmentRows.length
    ? db.select().from(scores).where(inArray(scores.assignmentId, assignmentRows.map((a) => a.id))).all()
    : [];
  const scoreIds = scoreRows.map((x) => x.id);
  return JSON.stringify(
    {
      format: "dogfood-portal/event-export/v1",
      exportedAt: new Date().toISOString(),
      event,
      tracks: db.select().from(tracks).where(eq(tracks.eventId, event.id)).all(),
      prizes: db.select().from(prizes).where(eq(prizes.eventId, event.id)).all(),
      rubric: db.select().from(rubricCriteria).where(eq(rubricCriteria.eventId, event.id)).all(),
      questions: db.select().from(customQuestions).where(eq(customQuestions.eventId, event.id)).all(),
      /** what teams are asked for each built-in field: required, optional or hidden */
      projectFields: fieldModes(db, event.id),
      teams: db.select().from(teams).where(eq(teams.eventId, event.id)).all().map(({ inviteCode: _code, ...t }) => t),
      members: db
        .select({ teamId: teamMembers.teamId, role: teamMembers.role, email: users.email, name: users.name })
        .from(teamMembers)
        .innerJoin(users, eq(users.id, teamMembers.userId))
        .where(eq(teamMembers.eventId, event.id))
        .all(),
      projects: db.select().from(projects).where(eq(projects.eventId, event.id)).all(),
      answers: projectIds.length ? db.select().from(customAnswers).where(inArray(customAnswers.projectId, projectIds)).all() : [],
      judges: db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .where(and(eq(userRoles.eventId, event.id), eq(userRoles.role, "judge")))
        .all(),
      judgeTracks: db.select().from(judgeTracks).where(eq(judgeTracks.eventId, event.id)).all(),
      assignmentRuns: db.select().from(assignmentRuns).where(eq(assignmentRuns.eventId, event.id)).all(),
      assignments: assignmentRows,
      scores: scoreRows,
      scoreItems: scoreIds.length ? db.select().from(scoreItems).where(inArray(scoreItems.scoreId, scoreIds)).all() : [],
      scoreComments: scoreIds.length ? db.select().from(scoreComments).where(inArray(scoreComments.scoreId, scoreIds)).all() : [],
      judgeOverrides: db.select().from(judgeOverrides).where(eq(judgeOverrides.eventId, event.id)).all(),
      normalizationRuns: db.select().from(normalizationRuns).where(eq(normalizationRuns.eventId, event.id)).all(),
      comparisons: db.select().from(comparisons).where(eq(comparisons.eventId, event.id)).all(),
    },
    null,
    2,
  );
}

/**
 * The event in the organizers' own fixture format, the format importEventFile reads:
 * export here, import on another portal. Submitted projects and finished reviews
 * only, since the format has no drafts; decisions and settings stay in event.json.
 */
function fixturesJson(db: DbOrTx, event: EventRow): string {
  const judgeRows = db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.eventId, event.id), eq(userRoles.role, "judge")))
    .orderBy(asc(users.id))
    .all();
  const judgeTrackRows = db.select().from(judgeTracks).where(eq(judgeTracks.eventId, event.id)).all();
  const teamRows = db.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.eventId, event.id)).orderBy(asc(teams.id)).all();
  const memberRows = db
    .select({ teamId: teamMembers.teamId, email: users.email, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.eventId, event.id))
    .orderBy(asc(teamMembers.joinedAt), asc(users.email))
    .all();
  const projectRows = db
    .select()
    .from(projects)
    .where(and(eq(projects.eventId, event.id), eq(projects.status, "submitted")))
    .orderBy(asc(projects.id))
    .all();
  const submitted = new Set(projectRows.map((p) => p.id));
  // beyond the organizers' format, and only when the event asks for something other than the defaults
  const fields = changedFromDefaults(fieldModes(db, event.id));
  const scoreRows = judgeRows.flatMap((j) =>
    reviewsOf(db, j.id)
      .filter((r) => r.eventId === event.id && r.status === "done" && submitted.has(r.projectId))
      .map((r) => ({
        judge: j.id,
        project: r.projectId,
        criteria: Object.fromEntries(r.items.map((i) => [i.key, i.value])),
        ...(r.feedback ? { comment: r.feedback } : {}),
      })),
  );
  return JSON.stringify(
    {
      event: { id: event.id, name: event.name, submissions_close: event.submissionsCloseAt },
      tracks: db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.id)).all(),
      ...(Object.keys(fields).length ? { project_fields: fields } : {}),
      judges: judgeRows.map((j) => ({ ...j, tracks: judgeTrackRows.filter((t) => t.judgeUserId === j.id).map((t) => t.trackId).sort() })),
      teams: teamRows.map((t) => ({
        ...t,
        // the captain first, as the importer makes the first member captain
        members: memberRows.filter((m) => m.teamId === t.id).sort((a, b) => Number(b.role === "captain") - Number(a.role === "captain")).map((m) => m.email),
      })),
      projects: projectRows.map((p) => ({
        id: p.id,
        team: p.teamId,
        track: p.trackId,
        title: p.title,
        summary: p.summary,
        repo_url: p.repoUrl ?? "",
        // beyond the organizers' format, only when present, so fixture data exports byte for byte
        // an uploaded picture by its full address, which the importer (web addresses only) takes and another portal can load
        ...(p.thumbnailUrl ? { thumbnail_url: p.thumbnailUrl.startsWith("/uploads/") ? `${issuer()}${p.thumbnailUrl}` : p.thumbnailUrl } : {}),
        ...(p.galleryUrls.length ? { gallery_urls: p.galleryUrls } : {}),
        ...(p.tags.length ? { tags: p.tags } : {}),
        submitted_at: p.submittedAt,
      })),
      scores: scoreRows,
    },
    null,
    2,
  );
}

const EXPORTS: Record<string, Exporter> = {
  "scores.csv": scoresCsv,
  "projects.csv": projectsCsv,
  "normalized.csv": normalizedCsv,
  "audit.csv": (db, event) => auditCsv(db, event.id),
  "comparisons.csv": comparisonsCsv,
  "event.json": eventJson,
  "fixtures.json": fixturesJson,
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
