import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import {
  assignments,
  projects,
  rubricCriteria,
  scoreComments,
  scoreItems,
  scores,
  teams,
  tracks,
} from "../db/schema";
import { guardRead } from "../mutate";
import { inJudgeTracks, weightedTotal } from "./judging";
import { shownTitle } from "./project-fields";

export type ReviewItem = { key: string; label: string; value: number; weight: number };

export type JudgeReview = {
  assignmentId: string;
  eventId: string;
  projectId: string;
  projectTitle: string;
  teamName: string;
  trackId: string;
  trackName: string;
  batchNo: number;
  position: number;
  status: "pending" | "done" | "recused";
  items: ReviewItem[];
  /** weighted mean of the scored criteria; null until every criterion is scored */
  total: number | null;
  submittedAt: string | null;
  feedback: string;
};

export type JudgeScores = { judge: { id: string; name: string }; reviews: JudgeReview[] };

/**
 * A judge's own reviews. `requestedJudgeId` is what the request asked for (the
 * peer route's ?judge=); null means "mine". Anything other than the session's own
 * judge id is refused with 403, and the query below always uses the session's id:
 * there is no path on which one judge's request returns another judge's rows.
 */
export function getJudgeScores(actor: Actor | null, requestedJudgeId: string | null): JudgeScores {
  const allowed =
    requestedJudgeId === null
      ? guardRead(actor, "scores.read_own", { kind: "platform" })
      : guardRead(actor, "scores.read_judge", { kind: "judge_scores", judgeUserId: requestedJudgeId });
  return {
    judge: { id: allowed.userId, name: allowed.name },
    reviews: reviewsOf(getDb(), allowed.userId, { ownTracksOnly: true }),
  };
}

/**
 * Every review assigned to one judge, in the judge's own order. DAL-internal.
 * ownTracksOnly: what the judge may see (projects in their tracks now); exports pass
 * nothing and get every review.
 */
export function reviewsOf(db: DbOrTx, judgeUserId: string, opts: { ownTracksOnly?: boolean } = {}): JudgeReview[] {
  const rows = db
    .select({
      assignmentId: assignments.id,
      eventId: assignments.eventId,
      projectId: projects.id,
      projectTitle: shownTitle(),
      teamName: teams.name,
      trackId: tracks.id,
      trackName: tracks.name,
      batchNo: assignments.batchNo,
      position: assignments.position,
      status: assignments.status,
      scoreId: scores.id,
      submittedAt: scores.submittedAt,
      feedback: scoreComments.feedback,
    })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .leftJoin(scores, eq(scores.assignmentId, assignments.id))
    .leftJoin(scoreComments, eq(scoreComments.scoreId, scores.id))
    .where(and(eq(assignments.judgeUserId, judgeUserId), opts.ownTracksOnly ? inJudgeTracks : undefined))
    .orderBy(asc(assignments.eventId), asc(assignments.batchNo), asc(assignments.position), asc(assignments.id))
    .all();

  const scoreIds = rows.map((r) => r.scoreId).filter((id): id is string => Boolean(id));
  const items = scoreIds.length
    ? db
        .select({
          scoreId: scoreItems.scoreId,
          value: scoreItems.value,
          key: rubricCriteria.key,
          label: rubricCriteria.label,
          weight: rubricCriteria.weight,
          position: rubricCriteria.position,
        })
        .from(scoreItems)
        .innerJoin(rubricCriteria, eq(rubricCriteria.id, scoreItems.criterionId))
        .where(inArray(scoreItems.scoreId, scoreIds))
        .orderBy(asc(rubricCriteria.position))
        .all()
    : [];
  const byScore = new Map<string, ReviewItem[]>();
  for (const i of items) {
    const list = byScore.get(i.scoreId) ?? [];
    list.push({ key: i.key, label: i.label, value: i.value, weight: i.weight });
    byScore.set(i.scoreId, list);
  }

  const criteriaCount = new Map<string, number>();
  for (const e of new Set(rows.map((r) => r.eventId))) {
    criteriaCount.set(e, db.select({ id: rubricCriteria.id }).from(rubricCriteria).where(eq(rubricCriteria.eventId, e)).all().length);
  }

  return rows.map((r) => {
    const its = r.scoreId ? (byScore.get(r.scoreId) ?? []) : [];
    const complete = its.length > 0 && its.length === criteriaCount.get(r.eventId);
    return {
      assignmentId: r.assignmentId,
      eventId: r.eventId,
      projectId: r.projectId,
      projectTitle: r.projectTitle,
      teamName: r.teamName,
      trackId: r.trackId,
      trackName: r.trackName,
      batchNo: r.batchNo,
      position: r.position,
      status: r.status,
      items: its,
      total: complete ? weightedTotal(its, its.map((i) => i.value)) : null,
      submittedAt: r.submittedAt,
      feedback: r.feedback ?? "",
    };
  });
}
