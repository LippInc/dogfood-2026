import "server-only";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { authorize, type Actor, type Resource } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import {
  assignments,
  customAnswers,
  customQuestions,
  projects,
  scoreComments,
  scoreItems,
  scores,
  teamMembers,
  teams,
  tracks,
} from "../db/schema";
import { textEdit } from "@/lib/text-edit";
import { NotFoundError, ValidationError } from "../errors";
import { withoutHidden, type FieldModes } from "@/lib/project-fields";
import { fieldModes, shownTitle } from "./project-fields";
import { guardRead, mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { inJudgeTracks, rubricOf, weightedTotal, type Criterion } from "./judging";
import { parse } from "./parse";

// The judge's side: the console reads only the session judge's own assignments,
// and a review is saved only by the judge the assignment names (authorize() compares
// the assignment row with the session, never with anything in the request).
// A review is finished when every criterion is scored; until then it is a draft
// that the progress view shows as unfinished and the engine leaves out.

type AssignmentStatus = "pending" | "done" | "recused";

export type ConsoleProject = {
  id: string;
  title: string;
  summary: string;
  description: string;
  repoUrl: string | null;
  videoUrl: string | null;
  liveUrl: string | null;
  thumbnailUrl: string | null;
  galleryUrls: string[];
  tags: string[];
  teamName: string;
  teamSize: number;
  trackName: string;
  submittedAt: string | null;
  answers: { label: string; value: string }[];
};

export type ConsoleItem = {
  assignmentId: string;
  batchNo: number;
  position: number;
  status: AssignmentStatus;
  /** why this review cannot be changed now, in words; null when it can */
  readOnly: string | null;
  project: ConsoleProject;
  values: Record<string, number | null>;
  feedback: string;
  privateNote: string;
  submittedAt: string | null;
  updatedAt: string | null;
};

export type JudgeConsole = {
  event: Pick<EventRow, "id" | "slug" | "name" | "submissionsCloseAt" | "judgingCloseAt" | "resultsPublishedAt">;
  judge: { id: string; name: string };
  criteria: Criterion[];
  items: ConsoleItem[];
  /** the judge's own median minutes between finished reviews, when there is enough to say */
  minutesPerReview: number | null;
  showRanking: boolean;
  /** what teams were asked: a hidden field is empty on every project and not listed as missing */
  fields: FieldModes;
};

function assignmentResource(event: EventRow, a: { id: string; judgeUserId: string; status: AssignmentStatus; inJudgeTracks: boolean }): Resource {
  return { kind: "assignment", id: a.id, event: eventFacts(event), judgeUserId: a.judgeUserId, status: a.status, inJudgeTracks: a.inJudgeTracks };
}

/** Every assignment of the session's judge in one event, in their seeded order, with the review so far. */
export function getJudgeConsole(actor: Actor | null, eventIdOrSlug: string): JudgeConsole {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const judge = guardRead(actor, "judging.console", { kind: "event", event: eventFacts(event) });
  const criteria = rubricOf(db, event.id);
  const rows = db
    .select({
      assignmentId: assignments.id,
      judgeUserId: assignments.judgeUserId,
      batchNo: assignments.batchNo,
      position: assignments.position,
      status: assignments.status,
      projectId: projects.id,
      title: shownTitle(),
      summary: projects.summary,
      description: projects.description,
      repoUrl: projects.repoUrl,
      videoUrl: projects.videoUrl,
      liveUrl: projects.liveUrl,
      thumbnailUrl: projects.thumbnailUrl,
      galleryUrls: projects.galleryUrls,
      tags: projects.tags,
      teamName: teams.name,
      teamSize: sql<number>`(select count(*) from ${teamMembers} m where m.team_id = ${teams.id})`,
      trackName: tracks.name,
      projectSubmittedAt: projects.submittedAt,
      scoreId: scores.id,
      submittedAt: scores.submittedAt,
      updatedAt: scores.updatedAt,
      feedback: scoreComments.feedback,
      privateNote: scoreComments.privateNote,
    })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .leftJoin(scores, eq(scores.assignmentId, assignments.id))
    .leftJoin(scoreComments, eq(scoreComments.scoreId, scores.id))
    // The judge id is the session's, never a request parameter; a project outside the
    // judge's tracks is not shown at all.
    .where(and(eq(assignments.eventId, event.id), eq(assignments.judgeUserId, judge.userId), inJudgeTracks))
    .orderBy(asc(assignments.batchNo), asc(assignments.position), asc(assignments.id))
    .all();

  const scoreIds = rows.map((r) => r.scoreId).filter((x): x is string => Boolean(x));
  const items = scoreIds.length
    ? db.select().from(scoreItems).where(inArray(scoreItems.scoreId, scoreIds)).all()
    : [];
  const projectIds = rows.map((r) => r.projectId);
  const answers = projectIds.length
    ? db
        .select({ projectId: customAnswers.projectId, label: customQuestions.label, value: customAnswers.value, position: customQuestions.position })
        .from(customAnswers)
        .innerJoin(customQuestions, eq(customQuestions.id, customAnswers.questionId))
        .where(inArray(customAnswers.projectId, projectIds))
        .orderBy(asc(customQuestions.position))
        .all()
    : [];
  const keyOf = new Map(criteria.map((c) => [c.id, c.key]));
  const now = new Date();
  const fields = fieldModes(db, event.id);

  const consoleItems: ConsoleItem[] = rows.map((r) => {
    const values: Record<string, number | null> = Object.fromEntries(criteria.map((c) => [c.key, null]));
    for (const it of items) if (it.scoreId === r.scoreId && keyOf.has(it.criterionId)) values[keyOf.get(it.criterionId)!] = it.value;
    const decision = authorize(judge, "review.save", assignmentResource(event, { id: r.assignmentId, judgeUserId: r.judgeUserId, status: r.status, inJudgeTracks: true }), now);
    return {
      assignmentId: r.assignmentId,
      batchNo: r.batchNo,
      position: r.position,
      status: r.status,
      readOnly: decision.ok ? null : decision.message,
      project: withoutHidden({
        id: r.projectId,
        title: r.title,
        summary: r.summary,
        description: r.description,
        repoUrl: r.repoUrl,
        videoUrl: r.videoUrl,
        liveUrl: r.liveUrl,
        thumbnailUrl: r.thumbnailUrl,
        galleryUrls: r.galleryUrls,
        tags: r.tags,
        teamName: r.teamName,
        teamSize: r.teamSize,
        trackName: r.trackName,
        submittedAt: r.projectSubmittedAt,
        answers: answers.filter((a) => a.projectId === r.projectId).map(({ label, value }) => ({ label, value })),
      }, fields),
      values,
      feedback: r.feedback ?? "",
      privateNote: r.privateNote ?? "",
      submittedAt: r.submittedAt,
      updatedAt: r.updatedAt,
    };
  });

  return {
    event: {
      id: event.id,
      slug: event.slug,
      name: event.name,
      submissionsCloseAt: event.submissionsCloseAt,
      judgingCloseAt: event.judgingCloseAt,
      resultsPublishedAt: event.resultsPublishedAt,
    },
    judge: { id: judge.userId, name: judge.name },
    criteria,
    items: consoleItems,
    minutesPerReview: pace(consoleItems.map((i) => i.submittedAt)),
    showRanking: event.settings.judgeRanking !== false,
    fields,
  };
}

/** Median gap between consecutive finished reviews, ignoring breaks over an hour. */
function pace(times: (string | null)[]): number | null {
  const sorted = times.filter((t): t is string => Boolean(t)).map((t) => Date.parse(t)).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const minutes = (sorted[i]! - sorted[i - 1]!) / 60000;
    if (minutes >= 0.5 && minutes <= 60) gaps.push(minutes);
  }
  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

export const ReviewInput = z.object({
  values: z.record(z.string(), z.number().int().nullable()).default({}),
  feedback: z.string().max(4000).optional(),
  privateNote: z.string().max(4000).optional(),
});

export type SavedReview = {
  assignmentId: string;
  status: AssignmentStatus;
  submittedAt: string | null;
  updatedAt: string;
  total: number | null;
};

type AssignmentRow = { id: string; judgeUserId: string; projectId: string; eventId: string; status: AssignmentStatus; inJudgeTracks: boolean };

function loadAssignment(tx: DbOrTx, assignmentId: string): { a: AssignmentRow; event: EventRow } {
  const row = tx
    .select({
      id: assignments.id,
      judgeUserId: assignments.judgeUserId,
      projectId: assignments.projectId,
      eventId: assignments.eventId,
      status: assignments.status,
      inTracks: inJudgeTracks,
    })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .where(eq(assignments.id, assignmentId))
    .get();
  if (!row) throw new NotFoundError("Assignment");
  const { inTracks, ...rest } = row;
  return { a: { ...rest, inJudgeTracks: Boolean(inTracks) }, event: requireEvent(tx, row.eventId) };
}

/**
 * Save a judge's review of one assignment: any subset of criteria (null clears one),
 * the feedback to the team and the private note to organizers. The console calls
 * this on every change (autosave), so a save that changes nothing writes nothing.
 */
export function saveReview(actor: Actor | null, assignmentId: string, body: unknown): SavedReview {
  let a: AssignmentRow;
  let event: EventRow;
  return mutate({
    actor,
    action: "review.save",
    load: (tx) => {
      ({ a, event } = loadAssignment(tx, assignmentId));
      return assignmentResource(event, a);
    },
    run: (tx) => {
      const input = parse(ReviewInput, body);
      const criteria = rubricOf(tx, event.id);
      const byKey = new Map(criteria.map((c) => [c.key, c]));
      const errors: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(input.values)) {
        const c = byKey.get(key);
        if (!c) errors[`values.${key}`] = ["not a criterion of this event's rubric"];
        else if (value !== null && (value < c.scaleMin || value > c.scaleMax)) {
          errors[`values.${key}`] = [`a whole number from ${c.scaleMin} to ${c.scaleMax}`];
        }
      }
      if (Object.keys(errors).length) throw new ValidationError("Check the scores.", errors);

      const now = new Date().toISOString();
      let score = tx.select().from(scores).where(eq(scores.assignmentId, a.id)).get();
      const current = new Map<string, number>();
      if (score) {
        for (const it of tx.select().from(scoreItems).where(eq(scoreItems.scoreId, score.id)).all()) current.set(it.criterionId, it.value);
      }
      const comments = score ? tx.select().from(scoreComments).where(eq(scoreComments.scoreId, score.id)).get() : undefined;
      const wasFinished = criteria.length > 0 && criteria.every((c) => current.has(c.id));

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const changes: { c: Criterion; value: number | null }[] = [];
      for (const [key, value] of Object.entries(input.values)) {
        const c = byKey.get(key)!;
        const old = current.get(c.id) ?? null;
        if (old === value) continue;
        changes.push({ c, value });
        before[key] = old;
        after[key] = value;
      }
      const feedback = input.feedback ?? comments?.feedback ?? "";
      const privateNote = input.privateNote ?? comments?.privateNote ?? "";
      const feedbackChanged = feedback !== (comments?.feedback ?? "");
      const noteChanged = privateNote !== (comments?.privateNote ?? "");
      // A text change is recorded as the edit it made (where, what was taken out, what was written):
      // a judge cannot rewrite feedback or a note an organizer may have read and leave no trace of what
      // it said, and typing, which autosaves as it goes, adds only the new characters to each row. The
      // log is read by the event's organizers (who may read both texts) and administrators; a webhook
      // gets none of a review's values (src/server/webhooks.ts, SEALED).
      if (feedbackChanged) {
        before.feedbackChars = comments?.feedback.length ?? 0;
        after.feedbackChars = feedback.length;
        after.feedbackEdit = textEdit(comments?.feedback ?? "", feedback);
      }
      if (noteChanged) {
        before.privateNoteChars = comments?.privateNote.length ?? 0;
        after.privateNoteChars = privateNote.length;
        after.privateNoteEdit = textEdit(comments?.privateNote ?? "", privateNote);
      }

      const next = new Map(current);
      for (const { c, value } of changes) {
        if (value === null) next.delete(c.id);
        else next.set(c.id, value);
      }
      const finished = criteria.length > 0 && criteria.every((c) => next.has(c.id));
      const total = finished ? weightedTotal(criteria, criteria.map((c) => next.get(c.id)!)) : null;

      if (changes.length === 0 && !feedbackChanged && !noteChanged) {
        return {
          result: { assignmentId: a.id, status: a.status, submittedAt: score?.submittedAt ?? null, updatedAt: score?.updatedAt ?? now, total },
          audit: null,
        };
      }

      if (!score) {
        score = { id: newId("scr"), assignmentId: a.id, submittedAt: null, updatedAt: now, conflicted: false };
        tx.insert(scores).values(score).run();
      }
      for (const { c, value } of changes) {
        if (value === null) {
          tx.delete(scoreItems).where(and(eq(scoreItems.scoreId, score.id), eq(scoreItems.criterionId, c.id))).run();
        } else {
          tx.insert(scoreItems)
            .values({ scoreId: score.id, criterionId: c.id, value })
            .onConflictDoUpdate({ target: [scoreItems.scoreId, scoreItems.criterionId], set: { value } })
            .run();
        }
      }
      if (feedbackChanged || noteChanged) {
        tx.insert(scoreComments)
          .values({ scoreId: score.id, feedback, privateNote })
          .onConflictDoUpdate({ target: scoreComments.scoreId, set: { feedback, privateNote } })
          .run();
      }
      const submittedAt = finished ? (score.submittedAt ?? now) : null;
      const status: AssignmentStatus = finished ? "done" : "pending";
      tx.update(scores).set({ submittedAt, updatedAt: now }).where(eq(scores.id, score.id)).run();
      if (status !== a.status) tx.update(assignments).set({ status }).where(eq(assignments.id, a.id)).run();

      const action = finished && !wasFinished ? "review.submit" : finished && wasFinished ? "review.amend" : "review.save";
      return {
        result: { assignmentId: a.id, status, submittedAt, updatedAt: now, total },
        audit: {
          action,
          eventId: event.id,
          targetType: "assignment",
          targetId: a.id,
          before,
          after: { ...after, project: a.projectId, ...(total !== null ? { total: Math.round(total * 1000) / 1000 } : {}) },
        },
      };
    },
  });
}

export const RecuseInput = z.object({ reason: z.string().trim().min(3, "say why, in a few words").max(500) });

/** The judge declares a conflict of interest: the assignment leaves their batch and the engine. */
export function recuseAssignment(actor: Actor | null, assignmentId: string, body: unknown) {
  let a: AssignmentRow;
  let event: EventRow;
  return mutate({
    actor,
    action: "review.recuse",
    load: (tx) => {
      ({ a, event } = loadAssignment(tx, assignmentId));
      return assignmentResource(event, a);
    },
    run: (tx) => {
      const { reason } = parse(RecuseInput, body);
      tx.update(assignments).set({ status: "recused" }).where(eq(assignments.id, a.id)).run();
      return {
        result: { assignmentId: a.id, status: "recused" as const },
        audit: { action: "review.recuse", eventId: event.id, targetType: "assignment", targetId: a.id, before: { status: a.status }, after: { status: "recused", project: a.projectId, reason } },
      };
    },
  });
}

