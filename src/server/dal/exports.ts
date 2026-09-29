import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../authz";
import { toCsv, type Cell } from "../csv";
import { getDb, type DbOrTx } from "../db/client";
import {
  auditLog,
  comments,
  comparisons,
  assignmentRuns,
  assignments,
  customAnswers,
  customQuestions,
  judgeOverrides,
  judgeTracks,
  normalizationRuns,
  normalizedScores,
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
  voters,
  votes,
} from "../db/schema";
import { NotFoundError } from "../errors";
import { guardRead } from "../mutate";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { auditCsv, ballotsSealed, SEALED, voterLabel } from "./audit-log";
import { votingSettings } from "./voting";
import { computeNormalization } from "./normalization";
import { PAIRWISE_METHOD } from "./pairwise";
import { answeredPairs } from "./judges";
import { averageRanks } from "../judging/normalize";
import { competitionPlaces } from "@/lib/places";
import { getPublishedResults } from "./results";
import { tieBreakOf } from "./tiebreak";
import { issuer } from "./records";
import { eventReviews } from "./scores";
import { changedFromDefaults } from "@/lib/project-fields";
import { labelFor } from "../db/import-fixtures";
import { readTrackMoves } from "../db/track-moves";
import { BUILTIN_CRITERIA } from "../rubric-defaults";
import { canonicalJson } from "../util";
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
  // reviews that arrived by an import (the fixture at boot, or an uploaded event file) rather than typed here
  const imported = new Set(
    db
      .select({ id: assignments.id })
      .from(assignments)
      .innerJoin(assignmentRuns, eq(assignmentRuns.id, assignments.runId))
      .where(and(eq(assignments.eventId, event.id), eq(assignmentRuns.mode, "fixture")))
      .all()
      .map((a) => a.id),
  );
  const reviews = eventReviews(db, event.id);
  // the organizer's export is complete: what the team typed in project_title, even while the title is hidden, and
  // the name the reviews show (the team's, then) in shown_title, as projects.csv does
  const typed = new Map(db.select({ id: projects.id, title: projects.title }).from(projects).where(eq(projects.eventId, event.id)).all().map((p) => [p.id, p.title]));
  const rows: Cell[][] = [];
  for (const j of judges) {
    for (const r of reviews.get(j.id) ?? []) {
      const value = new Map(r.items.map((i) => [i.key, i.value]));
      rows.push([
        r.projectId,
        typed.get(r.projectId) ?? r.projectTitle,
        r.teamName,
        r.trackName,
        j.id,
        j.name,
        ...criteria.map((k) => value.get(k) ?? null),
        r.total === null ? null : Math.round(r.total * 1000) / 1000,
        r.status,
        r.submittedAt,
        r.feedback,
        imported.has(r.assignmentId) ? "import" : "portal",
        r.projectTitle,
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
      "source",
      "shown_title",
    ],
    rows,
  );
}

function projectsCsv(db: DbOrTx, event: EventRow): string {
  const reviews = sql<number>`(select count(*) from ${assignments} a where a.project_id = ${projects.id} and a.status = 'done')`;
  const rows = db
    .select({
      id: projects.id,
      // the organizer's export is complete: what the team typed, even while the title is hidden, and the name shown
      title: projects.title,
      shownTitle: shownTitle(),
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
    ["project_id", "title", "summary", "team_id", "team", "track", "status", "submitted_at", "repo_url", "duplicate_of", "finished_reviews", "shown_title"],
    rows.map((r) => [r.id, r.title, r.summary, r.teamId, r.team, r.track, r.status, r.submittedAt, r.repoUrl, r.duplicateOf, r.reviews, r.shownTitle]),
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

const NORMALIZED_HEAD = ["project_id", "title", "track", "team", "duplicate_of", "reviews_all", "reviews_counted", "raw_mean", "raw_mean_kept", "normalized", "normalized_se", "rank_raw", "rank_kept", "rank_normalized", "track_rank", "under_reviewed", "k", "beta2", "sigma2", "excluded_judges"];
const fixed = (v: number | null | undefined, digits: number) => (v === null || v === undefined ? "" : v.toFixed(digits));

type RunTableRow = { id: string; duplicateOf: string | null; nAll: number; rawKept: number | null; rankKept: number | null; trackRank: number | null; underReviewed: boolean; n?: number; rawAll?: number | null };

/**
 * After publishing, the ranking that was published, read from its stored run (normalization_runs and
 * normalized_scores) rather than worked out again: a later engine, or anything that moved since, cannot
 * change the file. The score engine's run keeps the columns normalized_scores lacks in its params; a run
 * stored before it did leaves those three empty. A pairwise run has columns of its own. Null before publishing.
 */
function publishedRunCsv(db: DbOrTx, event: EventRow): string | null {
  const runId = event.settings.publishedRunId;
  if (!event.resultsPublishedAt || !runId) return null;
  const run = db.select().from(normalizationRuns).where(eq(normalizationRuns.id, runId)).get();
  if (!run) return null;
  const stored = db
    .select({
      id: normalizedScores.projectId,
      n: normalizedScores.n,
      raw: normalizedScores.rawMean,
      score: normalizedScores.normalizedMean,
      se: normalizedScores.se,
      rankRaw: normalizedScores.rankRaw,
      rankNormalized: normalizedScores.rankNormalized,
    })
    .from(normalizedScores)
    .where(eq(normalizedScores.runId, runId))
    .all();
  const byId = new Map(stored.map((r) => [r.id, r]));
  const info = new Map(
    db
      .select({ id: projects.id, title: projects.title, trackId: projects.trackId, track: tracks.name, team: teams.name })
      .from(projects)
      .innerJoin(teams, eq(teams.id, projects.teamId))
      .innerJoin(tracks, eq(tracks.id, projects.trackId))
      .where(eq(projects.eventId, event.id))
      .all()
      .map((p) => [p.id, p]),
  );
  // places within a track, from the stored scores, as the published results page counts them
  const places = new Map<string, number>();
  const byTrack = new Map<string, Map<string, number>>();
  for (const r of stored) {
    const trackId = info.get(r.id)?.trackId;
    if (r.score === null || !trackId) continue;
    byTrack.set(trackId, (byTrack.get(trackId) ?? new Map()).set(r.id, r.score));
  }
  for (const scores of byTrack.values()) for (const [id, place] of averageRanks(scores)) places.set(id, place);
  const byRank = [...stored].sort((a, b) => (a.rankNormalized ?? 1e9) - (b.rankNormalized ?? 1e9) || a.id.localeCompare(b.id));

  // the tie-break stage, only when the published run used one: three columns more (TIE_HEAD), else the file is as before
  const tie = tieColumnsFromPublished(event.id);

  if (run.method === PAIRWISE_METHOD) {
    return toCsv(
      ["project_id", "title", "track", "team", "judges", "win_rate", "win_pct", "win_pct_se", "rank_plain", "rank_win_pct", "track_place"],
      byRank.map((r) => {
        const p = info.get(r.id);
        return [r.id, p?.title ?? "", p?.track ?? "", p?.team ?? "", r.n, fixed(r.raw, 4), fixed(r.score, 4), fixed(r.se, 4), r.rankRaw ?? "", r.rankNormalized ?? "", places.get(r.id) ?? ""];
      }),
    );
  }

  const params = run.params as { k?: number | null; beta2?: number; sigma2?: number; measured?: boolean; excluded?: string[]; merges?: { duplicate: string; into: string }[]; table?: RunTableRow[] };
  const table: RunTableRow[] =
    params.table ??
    [
      ...byRank.map((r) => ({ id: r.id, duplicateOf: null, nAll: Number.NaN, rawKept: null, rankKept: null, trackRank: places.get(r.id) ?? null, underReviewed: r.n < 2 })),
      ...(params.merges ?? []).map((m) => ({ id: m.duplicate, duplicateOf: m.into, nAll: Number.NaN, rawKept: null, rankKept: null, trackRank: null, underReviewed: false })),
    ];
  const measured = params.measured !== false;
  return toCsv(
    tie ? [...NORMALIZED_HEAD, ...TIE_HEAD] : NORMALIZED_HEAD,
    table.map((t) => {
      const p = info.get(t.id);
      const s = byId.get(t.id);
      const row = [
        t.id,
        p?.title ?? "",
        p?.track ?? "",
        p?.team ?? "",
        t.duplicateOf ?? "",
        Number.isNaN(t.nAll) ? "" : t.nAll,
        s ? s.n : (t.n ?? 0),
        fixed(s ? s.raw : t.rawAll, 4),
        fixed(t.rawKept, 4),
        fixed(s?.score, 4),
        fixed(s?.se, 4),
        s?.rankRaw ?? "",
        t.rankKept ?? "",
        s?.rankNormalized ?? "",
        t.trackRank ?? "",
        t.underReviewed ? "yes" : "no",
        params.k === null || params.k === undefined ? "" : params.k.toFixed(3),
        measured && typeof params.beta2 === "number" ? params.beta2.toFixed(4) : "",
        measured && typeof params.sigma2 === "number" ? params.sigma2.toFixed(4) : "",
        (params.excluded ?? []).join(" "),
      ];
      return tie ? [...row, ...tie(t.id)] : row;
    }),
  );
}

const TIE_HEAD = ["tie_break_figure", "track_place", "tie_broken_by"];

/**
 * The tie-break's columns for the published run, read from the published results (the stored figures): each tied
 * project's figure on the criterion, every ranked project's place in its track after the tie-break, and the
 * criterion's name where it split the project's tie. Null when the run used no tie-break.
 */
function tieColumnsFromPublished(eventId: string): ((id: string) => (string | number)[]) | null {
  const r = getPublishedResults(eventId);
  if (!r.published || !r.tieBreak) return null;
  const label = r.tieBreak.criterion;
  const cols = new Map<string, (string | number)[]>();
  for (const t of r.tracks) {
    const places = competitionPlaces(t.rows);
    t.rows.forEach((row, i) => cols.set(row.projectId, [fixed(row.tie, 4), places[i]!.place ?? "", row.tieBroken ? label : ""]));
  }
  return (id) => cols.get(id) ?? ["", "", ""];
}

/**
 * The engine's table: raw, raw without excluded judges, normalized, ranks and the move. Worked out
 * live until the results are published; from then on, the published run (publishedRunCsv).
 */
function normalizedCsv(db: DbOrTx, event: EventRow): string {
  const published = publishedRunCsv(db, event);
  if (published !== null) return published;
  const n = computeNormalization(db, event);
  const tie = tieBreakOf(db, event, n);
  const tied = new Map(tie?.groups.flatMap((g) => g.projects.map((p) => [p.id, p] as const)) ?? []);
  const tieCols = (id: string) => [fixed(tied.get(id)?.figure, 4), tie!.places[id] ?? "", tied.get(id)?.broken ? tie!.criterion.label : ""];
  return toCsv(
    tie ? [...NORMALIZED_HEAD, ...TIE_HEAD] : NORMALIZED_HEAD,
    n.projects.map((p) => [
      ...[
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
      ],
      ...(tie ? tieCols(p.id) : []),
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
 * The event in the organizers' own fixture format, the format importEventFile reads: export here, import on another
 * portal as a new event and get the same event back (tests/event-round-trip.test.ts). Beyond the organizers' keys it
 * carries, each only when there is something to carry: the rubric, questions and answers, the other dates, the
 * settings and prizes, the reviews' times and private notes, the duplicate merges and the organizers' other decisions,
 * the pairwise answers, the community ballots (sealed while voting is open), the comments and the published ranking.
 * Submitted projects and finished reviews only, since the format has no drafts (DATA-MODEL.md lists what stays).
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
  const reviews = eventReviews(db, event.id);
  // beyond the organizers' format: the judge's private note to the organizers, and when each review was finished
  // (a review from a file without times was finished when this portal imported it), so scores.csv reads the same
  // on the portal the event moves to
  const notes = new Map(
    db
      .select({ assignmentId: assignments.id, note: scoreComments.privateNote })
      .from(scoreComments)
      .innerJoin(scores, eq(scores.id, scoreComments.scoreId))
      .innerJoin(assignments, eq(assignments.id, scores.assignmentId))
      .where(eq(assignments.eventId, event.id))
      .all()
      .map((n) => [n.assignmentId, n.note]),
  );
  const scoreRows = judgeRows.flatMap((j) =>
    (reviews.get(j.id) ?? [])
      .filter((r) => r.status === "done" && submitted.has(r.projectId))
      .map((r) => ({
        judge: j.id,
        project: r.projectId,
        criteria: Object.fromEntries(r.items.map((i) => [i.key, i.value])),
        ...(r.feedback ? { comment: r.feedback } : {}),
        ...(notes.get(r.assignmentId) ? { private_note: notes.get(r.assignmentId) } : {}),
        ...(r.submittedAt ? { submitted_at: r.submittedAt } : {}),
      })),
  );
  // The rubric as set here, written only when it differs from what the importer makes of the scores' keys alone
  // (labels from the keys, the built-in texts, weight 1, first-seen order), so fixture data still exports as it came.
  const rubric = db
    .select({ key: rubricCriteria.key, label: rubricCriteria.label, prompt: rubricCriteria.prompt, weight: rubricCriteria.weight, anchors: rubricCriteria.anchors })
    .from(rubricCriteria)
    .where(eq(rubricCriteria.eventId, event.id))
    .orderBy(asc(rubricCriteria.position), asc(rubricCriteria.key))
    .all();
  const seenKeys = [...new Set(scoreRows.flatMap((s) => Object.keys(s.criteria)))];
  const derived = seenKeys.map((key) => ({
    key,
    label: labelFor(key),
    prompt: BUILTIN_CRITERIA[key]?.prompt ?? "",
    weight: 1,
    anchors: BUILTIN_CRITERIA[key]?.anchors ?? {},
  }));
  const questionRows = db
    .select({ id: customQuestions.id, label: customQuestions.label, help: customQuestions.help, type: customQuestions.type, required: customQuestions.required })
    .from(customQuestions)
    .where(eq(customQuestions.eventId, event.id))
    .orderBy(asc(customQuestions.position), asc(customQuestions.id))
    .all();
  const answerRows = projectRows.length
    ? db.select().from(customAnswers).where(inArray(customAnswers.projectId, projectRows.map((p) => p.id))).all()
    : [];
  const answersOf = (projectId: string) => Object.fromEntries(answerRows.filter((a) => a.projectId === projectId).map((a) => [a.questionId, a.value]));
  const history = eventHistory(db, event, submitted, new Set(judgeRows.map((j) => j.id)));
  return JSON.stringify(
    {
      event: {
        id: event.id,
        name: event.name,
        submissions_close: event.submissionsCloseAt,
        ...(event.description ? { description: event.description } : {}),
        // the event's other dates, beyond the organizers' format, each only when it is set
        ...(event.submissionsOpenAt ? { submissions_open: event.submissionsOpenAt } : {}),
        ...(event.judgingCloseAt ? { judging_close: event.judgingCloseAt } : {}),
        ...(event.votingOpenAt ? { voting_open: event.votingOpenAt } : {}),
        ...(event.votingCloseAt ? { voting_close: event.votingCloseAt } : {}),
      },
      tracks: db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.id)).all(),
      ...(Object.keys(fields).length ? { project_fields: fields } : {}),
      ...(canonicalJson(rubric) !== canonicalJson(derived) ? { rubric } : {}),
      ...(questionRows.length ? { questions: questionRows } : {}),
      ...history.settings,
      judges: judgeRows.map((j) => ({ ...j, tracks: judgeTrackRows.filter((t) => t.judgeUserId === j.id).map((t) => t.trackId).sort() })),
      teams: teamRows.map((t) => ({
        ...t,
        // the captain first, as the importer makes the first member captain; then by address, an order an import keeps
        members: memberRows
          .filter((m) => m.teamId === t.id)
          .sort((a, b) => Number(b.role === "captain") - Number(a.role === "captain") || a.email.localeCompare(b.email))
          .map((m) => m.email),
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
        ...(p.galleryUrls.length ? { gallery_urls: p.galleryUrls.map((u) => (u.startsWith("/uploads/") ? `${issuer()}${u}` : u)) } : {}),
        ...(p.tags.length ? { tags: p.tags } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.videoUrl ? { video_url: p.videoUrl } : {}),
        ...(p.liveUrl ? { live_url: p.liveUrl } : {}),
        ...(answerRows.some((a) => a.projectId === p.id) ? { answers: answersOf(p.id) } : {}),
        // the organizer's duplicate merge: this copy counts as the one it names
        ...(p.duplicateOf ? { duplicate_of: p.duplicateOf } : {}),
        submitted_at: p.submittedAt,
      })),
      scores: scoreRows,
      ...history.rest,
    },
    null,
    2,
  );
}

/**
 * Every assignment: who reviews what, how far each review got, and when. review is none (nothing saved), draft
 * (something saved, not every criterion) or submitted; pairwise mode saves answers and no review rows, so a review
 * with no review row whose project the judge has a standing answer about is answered, last saved at the latest such
 * answer. A
 * recused one carries the judge's reason and when, from the log. run says how the pair was made: an import, a fresh
 * run, a top-up, or by hand.
 */
function assignmentsCsv(db: DbOrTx, event: EventRow): string {
  const rows = db
    .select({
      id: assignments.id,
      judgeId: assignments.judgeUserId,
      judge: users.name,
      projectId: assignments.projectId,
      title: projects.title,
      track: tracks.name,
      status: assignments.status,
      createdAt: assignments.createdAt,
      runId: assignments.runId,
      mode: assignmentRuns.mode,
      params: assignmentRuns.params,
      scoreId: scores.id,
      savedAt: scores.updatedAt,
      submittedAt: scores.submittedAt,
    })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.judgeUserId))
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .innerJoin(assignmentRuns, eq(assignmentRuns.id, assignments.runId))
    .leftJoin(scores, eq(scores.assignmentId, assignments.id))
    .where(eq(assignments.eventId, event.id))
    .orderBy(asc(assignments.judgeUserId), asc(assignments.projectId))
    .all();
  // a recusal's reason and time: the latest review.recuse row of each assignment
  const recusals = new Map<string, { at: string; reason: string }>();
  for (const r of db
    .select({ targetId: auditLog.targetId, at: auditLog.at, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, event.id), eq(auditLog.action, "review.recuse")))
    .orderBy(desc(auditLog.id))
    .all()) {
    const reason = (r.after as { reason?: unknown } | null)?.reason;
    if (r.targetId && !recusals.has(r.targetId)) recusals.set(r.targetId, { at: r.at, reason: typeof reason === "string" ? reason : "" });
  }
  // Pairwise mode writes no review rows: a review whose project the judge has a standing answer about reads
  // "answered", last saved at the latest such answer (the rule removeAssignment and the judges API count as started).
  // Not keyed on the mode: an event switched back to scores keeps its answers, and removeAssignment still refuses them.
  const answered = answeredPairs(db, event.id);
  const runName = (mode: string, params: Record<string, unknown> | null) =>
    params?.byHand ? "by hand" : mode === "fixture" ? "import" : mode === "fresh" ? "fresh run" : "top-up";
  return toCsv(
    ["assignment_id", "judge_id", "judge", "project_id", "project_title", "track", "status", "review", "assigned_at", "last_saved_at", "submitted_at", "recused_at", "recuse_reason", "run_id", "run"],
    rows.map((r) => {
      const recused = r.status === "recused" ? recusals.get(r.id) : undefined;
      const answeredAt = r.scoreId ? undefined : answered.get(`${r.judgeId}|${r.projectId}`);
      return [
        r.id,
        r.judgeId,
        r.judge,
        r.projectId,
        r.title,
        r.track,
        r.status,
        r.submittedAt ? "submitted" : r.scoreId ? "draft" : answeredAt ? "answered" : "none",
        r.createdAt,
        r.savedAt ?? answeredAt ?? null,
        r.submittedAt,
        recused?.at ?? null,
        recused?.reason ?? null,
        r.runId,
        runName(r.mode, r.params),
      ];
    }),
  );
}

/**
 * Every ballot, one row per voter, in the order they came in: how they voted in (kind), whether the ballot counts
 * (a ballot set aside does not; an open-link ballot counts apart unless the organizer counts it), and the picks.
 * The picks stay sealed until the voting window closes, exactly as audit.csv seals a ballot (ballotsSealed): until
 * then both pick columns read "hidden until voting closes", for every ballot, cast or not.
 */
function votesCsv(db: DbOrTx, event: EventRow): string {
  const sealed = ballotsSealed(db, event.id);
  const { countLink } = votingSettings(event);
  const people = db
    .select({
      id: voters.id,
      kind: voters.kind,
      userId: voters.userId,
      name: users.name,
      email: voters.email,
      createdAt: voters.createdAt,
      lastVotedAt: voters.lastVotedAt,
      voidedAt: voters.voidedAt,
      voidReason: voters.voidReason,
    })
    .from(voters)
    .leftJoin(users, eq(users.id, voters.userId))
    .where(eq(voters.eventId, event.id))
    .orderBy(asc(voters.createdAt), asc(voters.id))
    .all();
  const picks = new Map<string, { id: string; title: string }[]>();
  if (!sealed) {
    for (const v of db
      .select({ voterId: votes.voterId, projectId: votes.projectId, title: projects.title })
      .from(votes)
      .innerJoin(voters, eq(voters.id, votes.voterId))
      .innerJoin(projects, eq(projects.id, votes.projectId))
      .where(eq(voters.eventId, event.id))
      .orderBy(asc(votes.voterId), asc(votes.projectId))
      .all()) {
      picks.set(v.voterId, [...(picks.get(v.voterId) ?? []), { id: v.projectId, title: v.title }]);
    }
  }
  const counts = (v: (typeof people)[number]) => (v.voidedAt ? "set aside" : v.kind === "link" && !countLink ? "apart" : "yes");
  return toCsv(
    ["voter_id", "kind", "voter", "user_id", "email", "joined_at", "last_voted_at", "counts", "set_aside_at", "set_aside_reason", "picks", "pick_titles"],
    people.map((v) => [
      v.id,
      v.kind,
      voterLabel(v),
      v.userId,
      v.email,
      v.createdAt,
      v.lastVotedAt,
      counts(v),
      v.voidedAt,
      v.voidReason,
      sealed ? SEALED : (picks.get(v.id) ?? []).map((p) => p.id).join("; "),
      sealed ? SEALED : (picks.get(v.id) ?? []).map((p) => p.title).join("; "),
    ]),
  );
}

/**
 * Every comment, in the order posted. A comment an organizer hid keeps its row with who hid it, when and why, and
 * an empty body: its words never leave the portal again.
 */
function commentsCsv(db: DbOrTx, event: EventRow): string {
  const rows = db
    .select({
      id: comments.id,
      at: comments.createdAt,
      projectId: comments.projectId,
      title: projects.title,
      userId: comments.userId,
      author: users.name,
      body: comments.body,
      hiddenAt: comments.hiddenAt,
      hiddenBy: comments.hiddenBy,
      hiddenReason: comments.hiddenReason,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .innerJoin(projects, eq(projects.id, comments.projectId))
    .where(eq(comments.eventId, event.id))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();
  // who hid each hidden one, by name (an organizer, or an administrator)
  const hiderIds = [...new Set(rows.flatMap((r) => (r.hiddenBy ? [r.hiddenBy] : [])))];
  const hiders = new Map(
    hiderIds.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, hiderIds)).all().map((u) => [u.id, u.name]) : [],
  );
  return toCsv(
    ["comment_id", "posted_at", "project_id", "project_title", "author_id", "author", "status", "body", "hidden_at", "hidden_by", "hidden_reason"],
    rows.map((r) => [
      r.id,
      r.at,
      r.projectId,
      r.title,
      r.userId,
      r.author,
      r.hiddenAt ? "hidden" : "shown",
      r.hiddenAt ? null : r.body,
      r.hiddenAt,
      r.hiddenBy ? (hiders.get(r.hiddenBy) ?? r.hiddenBy) : null,
      r.hiddenReason,
    ]),
  );
}

/**
 * What an event holds beyond the organizers' format, for fixtures.json, each part only when there is something in
 * it (so the organizers' fixture data still exports as it came): its settings and prizes (placed with the rubric),
 * and after the scores the organizers' decisions, the pairwise answers, the community ballots, the comments and the
 * published ranking. Ballots follow audit.csv's seal: while voting has not closed their picks stay out, and the file
 * says only how many there are. Rows whose person or project the file does not carry (a judge removed from the
 * event, a project taken back to a draft) stay out, as their reviews do.
 */
function eventHistory(db: DbOrTx, event: EventRow, submitted: Set<string>, judgeIds: Set<string>) {
  const s = event.settings;
  const tieKey = s.tieBreak ? (db.select({ key: rubricCriteria.key }).from(rubricCriteria).where(eq(rubricCriteria.id, s.tieBreak.criterionId)).get()?.key ?? null) : null;
  const settings: Record<string, unknown> = {
    ...(s.maxTeamSize !== undefined ? { max_team_size: s.maxTeamSize } : {}),
    ...(s.certificatePlaces !== undefined ? { certificate_places: s.certificatePlaces } : {}),
    ...(s.reviewsPerProject !== undefined ? { reviews_per_project: s.reviewsPerProject } : {}),
    ...(s.judgeRanking !== undefined ? { judge_ranking: s.judgeRanking } : {}),
    ...(s.judgingMode !== undefined ? { judging_mode: s.judgingMode } : {}),
    ...(s.accent !== undefined ? { accent: s.accent } : {}),
    // the criterion that breaks exact ties, by its key (the rubric travels by key; a new portal gives it its own id)
    ...(tieKey ? { tie_break: tieKey } : {}),
    // who may vote and how many favourites each; never the open link's hash (a new portal makes its own link)
    ...(s.voting
      ? {
          voting: {
            modes: [...s.voting.modes],
            votes_per_voter: s.voting.votesPerVoter,
            ...(s.voting.countLink !== undefined ? { count_link: s.voting.countLink } : {}),
            ...(s.voting.linkPerAddress !== undefined ? { link_per_address: s.voting.linkPerAddress } : {}),
          },
        }
      : {}),
  };
  const prizeRows = db
    .select({ id: prizes.id, name: prizes.name, description: prizes.description })
    .from(prizes)
    .where(eq(prizes.eventId, event.id))
    .orderBy(asc(prizes.position), asc(prizes.id))
    .all();

  const overrides = db
    .select()
    .from(judgeOverrides)
    .where(eq(judgeOverrides.eventId, event.id))
    .orderBy(asc(judgeOverrides.createdAt), asc(judgeOverrides.id))
    .all()
    .filter((o) => judgeIds.has(o.judgeUserId));
  const moves = readTrackMoves(db, event.id).filter((m) => submitted.has(m.projectId));
  const decisions: Record<string, unknown> = {
    ...(overrides.length
      ? {
          judges: overrides.map((o) => ({ id: o.id, judge: o.judgeUserId, mode: o.mode, reason: o.reason, at: o.createdAt, ...(o.revokedAt ? { revoked_at: o.revokedAt } : {}) })),
        }
      : {}),
    ...(s.notDuplicates?.length ? { not_duplicates: [...s.notDuplicates] } : {}),
    ...(s.acceptedUnderReviewed?.length ? { accepted_under_reviewed: [...s.acceptedUnderReviewed] } : {}),
    ...(s.weightChanges?.length ? { weight_changes: s.weightChanges } : {}),
    ...(s.tieBreakChanges?.length ? { tie_break_changes: s.tieBreakChanges } : {}),
    ...(s.voteRuleChanges?.length ? { vote_rule_changes: s.voteRuleChanges } : {}),
    ...(s.voteCountChanges?.length ? { vote_count_changes: s.voteCountChanges } : {}),
    // projects moved to another track after judges were assigned, each with its reason (the audit log keeps them)
    ...(moves.length ? { track_moves: moves.map((m) => ({ project: m.projectId, from: m.fromTrackId, to: m.toTrackId, reason: m.reason, at: m.at })) } : {}),
  };

  const answers = db
    .select()
    .from(comparisons)
    .where(eq(comparisons.eventId, event.id))
    .orderBy(asc(comparisons.createdAt), asc(comparisons.id))
    .all()
    .filter((c) => judgeIds.has(c.judgeUserId) && submitted.has(c.leftProjectId) && submitted.has(c.rightProjectId));

  const voterRows = db
    .select({ voter: voters, email: users.email })
    .from(voters)
    .leftJoin(users, eq(users.id, voters.userId))
    .where(eq(voters.eventId, event.id))
    .orderBy(asc(voters.createdAt), asc(voters.id))
    .all();
  const pickRows = voterRows.length
    ? db
        .select({ voterId: votes.voterId, projectId: votes.projectId, at: votes.createdAt })
        .from(votes)
        .innerJoin(voters, eq(voters.id, votes.voterId))
        .where(eq(voters.eventId, event.id))
        .orderBy(asc(votes.createdAt), asc(votes.projectId))
        .all()
    : [];
  const sealed = ballotsSealed(db, event.id);
  const who = (v: (typeof voterRows)[number]) =>
    v.voter.kind === "account" ? { kind: "account", email: v.email ?? "" } : v.voter.kind === "listed" ? { kind: "listed", email: v.voter.email ?? "" } : { kind: "link" };
  // While sealed, only the voter list moves (the addresses the organizers added), with nothing that says who voted. An
  // address set aside stays set aside, with its reason and when: that is the organizers' ruling, not a pick.
  const setAside = (v: (typeof voterRows)[number]) => (v.voter.voidedAt ? { set_aside: { at: v.voter.voidedAt, reason: v.voter.voidReason ?? "" } } : {});
  const ballots = sealed
    ? voterRows
        .filter((v) => v.voter.kind === "listed")
        .map((v) => ({ id: v.voter.id, voter: who(v), order_seed: v.voter.orderSeed, created_at: v.voter.createdAt, ...setAside(v), picks: [] }))
    : voterRows.map((v) => ({
        id: v.voter.id,
        voter: who(v),
        order_seed: v.voter.orderSeed,
        created_at: v.voter.createdAt,
        ...(v.voter.lastVotedAt ? { last_voted_at: v.voter.lastVotedAt } : {}),
        ...setAside(v),
        picks: pickRows.filter((p) => p.voterId === v.voter.id && submitted.has(p.projectId)).map((p) => ({ project: p.projectId, at: p.at })),
      }));
  const sealedCount = sealed ? voterRows.filter((v) => v.voter.lastVotedAt !== null).length : 0;

  const commentRows = db
    .select({ c: comments, email: users.email, name: users.name })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.eventId, event.id))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all()
    .filter((r) => submitted.has(r.c.projectId));

  let published: Record<string, unknown> | null = null;
  const runId = s.publishedRunId;
  if (event.resultsPublishedAt && runId) {
    const run = db.select().from(normalizationRuns).where(eq(normalizationRuns.id, runId)).get();
    if (run) {
      const rows = db.select().from(normalizedScores).where(eq(normalizedScores.runId, runId)).orderBy(asc(normalizedScores.projectId)).all();
      published = {
        at: event.resultsPublishedAt,
        run: { id: run.id, method: run.method, computed_at: run.computedAt, params: run.params },
        scores: rows.map((r) => ({
          project: r.projectId,
          n: r.n,
          raw_mean: r.rawMean,
          normalized_mean: r.normalizedMean,
          se: r.se,
          rank_raw: r.rankRaw,
          rank_normalized: r.rankNormalized,
        })),
      };
    }
  }

  return {
    settings: {
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(prizeRows.length ? { prizes: prizeRows } : {}),
    },
    rest: {
      ...(Object.keys(decisions).length ? { decisions } : {}),
      ...(answers.length
        ? {
            comparisons: answers.map((c) => ({
              id: c.id,
              judge: c.judgeUserId,
              track: c.trackId,
              left: c.leftProjectId,
              right: c.rightProjectId,
              new: c.newProjectId,
              answer: c.outcome,
              at: c.createdAt,
              ...(c.voidedAt ? { taken_back_at: c.voidedAt } : {}),
            })),
          }
        : {}),
      ...(ballots.length ? { ballots } : {}),
      ...(sealedCount ? { ballots_sealed: sealedCount } : {}),
      ...(commentRows.length
        ? {
            comments: commentRows.map(({ c, email, name }) => ({
              id: c.id,
              project: c.projectId,
              author: email,
              author_name: name,
              body: c.body,
              at: c.createdAt,
              ...(c.hiddenAt ? { hidden: { at: c.hiddenAt, reason: c.hiddenReason ?? "" } } : {}),
            })),
          }
        : {}),
      ...(published ? { published } : {}),
    },
  };
}

const EXPORTS: Record<string, Exporter> = {
  "scores.csv": scoresCsv,
  "projects.csv": projectsCsv,
  "assignments.csv": assignmentsCsv,
  "normalized.csv": normalizedCsv,
  "audit.csv": (db, event) => auditCsv(db, event.id),
  "comparisons.csv": comparisonsCsv,
  "votes.csv": votesCsv,
  "comments.csv": commentsCsv,
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
