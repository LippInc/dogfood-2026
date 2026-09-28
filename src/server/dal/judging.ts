import "server-only";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { assignments, judgeOverrides, judgeTracks, projects, rubricCriteria, scoreItems, scores, teams, tracks, userRoles, users } from "../db/schema";
import { excludedJudges, flatJudges, type FinishedReview, type FlatFlag, type Override } from "../judging/flat";
import { shownTitle } from "./project-fields";

// Shared loaders for the judging side: the rubric, the finished reviews (every
// criterion scored), the flat-judge flags and the organizer's overrides. The
// assignment run, the dashboard and the normalization run all read through here.

/**
 * SQL condition for a query that joins `assignments` to `projects`: the project is
 * in one of the assigned judge's tracks now. A track judge never sees another
 * track, so every judge-facing read and write checks it, not only the assignment
 * run: a project a team moved, or a track the organizer took from a judge, leaves
 * that judge's view. Finished reviews stay in the data for the organizer.
 */
export const inJudgeTracks = sql<number>`exists (select 1 from ${judgeTracks} jt where jt.judge_user_id = ${assignments.judgeUserId} and jt.event_id = ${assignments.eventId} and jt.track_id = ${projects.trackId})`;

export type Criterion = {
  id: string;
  key: string;
  label: string;
  prompt: string;
  weight: number;
  scaleMin: number;
  scaleMax: number;
  anchors: Record<string, string>;
};

export function rubricOf(db: DbOrTx, eventId: string): Criterion[] {
  return db
    .select({
      id: rubricCriteria.id,
      key: rubricCriteria.key,
      label: rubricCriteria.label,
      prompt: rubricCriteria.prompt,
      weight: rubricCriteria.weight,
      scaleMin: rubricCriteria.scaleMin,
      scaleMax: rubricCriteria.scaleMax,
      anchors: rubricCriteria.anchors,
    })
    .from(rubricCriteria)
    .where(eq(rubricCriteria.eventId, eventId))
    .orderBy(asc(rubricCriteria.position), asc(rubricCriteria.key))
    .all();
}

/** Σ weight × value ÷ Σ weight over the criteria. */
export function weightedTotal(criteria: readonly Pick<Criterion, "weight">[], values: readonly number[]): number {
  let sum = 0;
  let weights = 0;
  criteria.forEach((c, i) => {
    sum += c.weight * values[i]!;
    weights += c.weight;
  });
  return sum / weights;
}

export type FinishedReviewRow = FinishedReview & { scoreId: string; assignmentId: string; submittedAt: string | null };

/**
 * Reviews with every criterion scored, values in rubric order. A review missing a
 * criterion is unfinished: it is left out here (and so out of the fit and the raw
 * mean), never filled with a zero. Recused assignments and conflicted imports are
 * left out too.
 */
export function finishedReviews(db: DbOrTx, eventId: string, criteria = rubricOf(db, eventId)): FinishedReviewRow[] {
  const rows = db
    .select({
      assignmentId: assignments.id,
      judgeId: assignments.judgeUserId,
      projectId: assignments.projectId,
      scoreId: scores.id,
      submittedAt: scores.submittedAt,
      criterionId: scoreItems.criterionId,
      value: scoreItems.value,
    })
    .from(assignments)
    .innerJoin(scores, eq(scores.assignmentId, assignments.id))
    .innerJoin(scoreItems, eq(scoreItems.scoreId, scores.id))
    .where(and(eq(assignments.eventId, eventId), ne(assignments.status, "recused"), eq(scores.conflicted, false)))
    .all();
  const index = new Map(criteria.map((c, i) => [c.id, i]));
  const byScore = new Map<string, FinishedReviewRow & { seen: number }>();
  for (const r of rows) {
    const at = index.get(r.criterionId);
    if (at === undefined) continue;
    let review = byScore.get(r.scoreId);
    if (!review) {
      review = {
        scoreId: r.scoreId,
        assignmentId: r.assignmentId,
        judgeId: r.judgeId,
        projectId: r.projectId,
        submittedAt: r.submittedAt,
        values: new Array<number>(criteria.length).fill(Number.NaN),
        seen: 0,
      };
      byScore.set(r.scoreId, review);
    }
    if (Number.isNaN(review.values[at]!)) review.seen += 1;
    review.values[at] = r.value;
  }
  return [...byScore.values()]
    .filter((r) => r.seen === criteria.length && criteria.length > 0)
    .map(({ seen: _seen, ...r }) => r)
    .sort((a, b) => (a.scoreId < b.scoreId ? -1 : 1));
}

export type ActiveOverride = Override & { id: string; reason: string; createdAt: string; createdBy: string };

export function activeOverrides(db: DbOrTx, eventId: string): ActiveOverride[] {
  return db
    .select({
      id: judgeOverrides.id,
      judgeId: judgeOverrides.judgeUserId,
      mode: judgeOverrides.mode,
      reason: judgeOverrides.reason,
      createdAt: judgeOverrides.createdAt,
      createdBy: judgeOverrides.createdBy,
    })
    .from(judgeOverrides)
    .where(and(eq(judgeOverrides.eventId, eventId), isNull(judgeOverrides.revokedAt)))
    .orderBy(asc(judgeOverrides.createdAt))
    .all();
}

export type JudgeSet = { flags: FlatFlag[]; overrides: ActiveOverride[]; excluded: string[] };

/** Which judges the engine leaves out right now, and why. */
export function judgeSet(db: DbOrTx, eventId: string, reviews = finishedReviews(db, eventId)): JudgeSet {
  const flags = flatJudges(reviews);
  const overrides = activeOverrides(db, eventId);
  return { flags, overrides, excluded: excludedJudges(flags, overrides) };
}

// Moved from normalization.ts so the score engine and the pairwise engine share them.
export type ProjectInfo = {
  id: string;
  /** the name it is shown under (the team's name while the organizer hides the title) */
  title: string;
  /** what the team typed, which duplicate matching compares */
  typedTitle: string;
  trackId: string;
  trackName: string;
  teamId: string;
  teamName: string;
  duplicateOf: string | null;
  submittedAt: string | null;
  repoUrl: string | null;
};

export function submittedProjects(db: DbOrTx, eventId: string): ProjectInfo[] {
  return db
    .select({
      id: projects.id,
      title: shownTitle(),
      typedTitle: projects.title,
      trackId: projects.trackId,
      trackName: tracks.name,
      teamId: projects.teamId,
      teamName: teams.name,
      duplicateOf: projects.duplicateOf,
      submittedAt: projects.submittedAt,
      repoUrl: projects.repoUrl,
    })
    .from(projects)
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted")))
    .orderBy(asc(tracks.position), asc(projects.id))
    .all();
}

export function judgeNames(db: DbOrTx, eventId: string): Map<string, string> {
  return new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .all()
      .map((u) => [u.id, u.name]),
  );
}
