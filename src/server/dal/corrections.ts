import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignmentRuns, assignments, auditLog, judgeTracks, projects, scores, teams, tracks, users } from "../db/schema";
import { ConflictError, NotFoundError } from "../errors";
import { guardRead, mutate, type MutationSpec } from "../mutate";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { isJudgeIn } from "./judges";
import { parse } from "./parse";

// The organizer's audited corrections to the judging set-up: taking back an assignment
// nobody has started, and undoing a recusal clicked by mistake. Each asks for a reason,
// writes its audit row in the same transaction, and stops once the results are published,
// when the assignments are final. None of them touches a saved score.

const Reason = z.string().trim().min(3, "say why, in a few words").max(500);
export const CorrectionInput = z.object({ reason: Reason });

function correctionsOpen(event: EventRow) {
  if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so the assignments are final.");
}

type AssignmentFacts = { id: string; eventId: string; judgeUserId: string; projectId: string; runId: string; status: "pending" | "done" | "recused" };

/** One assignment of this event; another event's id is a 404, never a match. */
function eventAssignment(tx: DbOrTx, event: EventRow, assignmentId: string): AssignmentFacts {
  const row = tx
    .select({
      id: assignments.id,
      eventId: assignments.eventId,
      judgeUserId: assignments.judgeUserId,
      projectId: assignments.projectId,
      runId: assignments.runId,
      status: assignments.status,
    })
    .from(assignments)
    .where(and(eq(assignments.id, assignmentId), eq(assignments.eventId, event.id)))
    .get();
  if (!row) throw new NotFoundError("Assignment");
  return row;
}

function organizerCorrection<T>(
  actor: Actor | null,
  eventIdOrSlug: string,
  assignmentId: string,
  run: (tx: DbOrTx, event: EventRow, a: AssignmentFacts) => ReturnType<MutationSpec<T>["run"]>,
) {
  let event: EventRow;
  return mutate<T>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      correctionsOpen(event);
      return run(tx, event, eventAssignment(tx, event, assignmentId));
    },
  });
}

/**
 * Take back an assignment nobody has started: the judge has saved nothing on it (a review
 * with even one score or a word of feedback stays, since it is the judge's work; they
 * declare a conflict themselves if the project is not theirs). A recusal stays too: it is the
 * record that keeps the engine from giving the project back to that judge. Runs treat a
 * taken-back pair as a conflict from then on; an organizer can still assign it by hand.
 */
export function removeAssignment(actor: Actor | null, eventIdOrSlug: string, assignmentId: string, body: unknown) {
  return organizerCorrection<{ removed: string; projectId: string; judgeUserId: string }>(actor, eventIdOrSlug, assignmentId, (tx, event, a) => {
    const { reason } = parse(CorrectionInput, body);
    if (a.status === "recused") {
      throw new ConflictError("recused", "The judge declared a conflict on this project. That stays on record, so no run gives the project back to them.");
    }
    if (tx.select({ id: scores.id }).from(scores).where(eq(scores.assignmentId, a.id)).get()) {
      throw new ConflictError(
        "review_started",
        "The judge has already saved part of this review, so it stays in the record. If the project is not theirs to judge, they declare a conflict in their console.",
      );
    }
    tx.delete(assignments).where(eq(assignments.id, a.id)).run();
    return {
      result: { removed: a.id, projectId: a.projectId, judgeUserId: a.judgeUserId },
      audit: {
        action: "assignment.remove",
        eventId: event.id,
        targetType: "project",
        targetId: a.projectId,
        before: { assignment: a.id, judgeUserId: a.judgeUserId, status: a.status, run: a.runId },
        after: { judgeUserId: a.judgeUserId, reason },
      },
    };
  });
}

/**
 * Undo a judge's recusal, for one clicked by mistake: the review comes back to the judge's
 * console as it was (finished if it was finished) and counts again. The judge's own reason
 * stays in the log next to the organizer's.
 */
export function undoRecusal(actor: Actor | null, eventIdOrSlug: string, assignmentId: string, body: unknown) {
  return organizerCorrection<{ assignmentId: string; status: "pending" | "done" | "recused" }>(actor, eventIdOrSlug, assignmentId, (tx, event, a) => {
    const { reason } = parse(CorrectionInput, body);
    if (a.status !== "recused") return { result: { assignmentId: a.id, status: a.status }, audit: null };
    if (!isJudgeIn(tx, a.judgeUserId, event.id)) {
      throw new ConflictError("not_a_judge", "This person is no longer a judge of this event, so the review cannot come back to them.");
    }
    const score = tx.select({ submittedAt: scores.submittedAt }).from(scores).where(eq(scores.assignmentId, a.id)).get();
    const status = score?.submittedAt ? "done" : "pending";
    tx.update(assignments).set({ status }).where(eq(assignments.id, a.id)).run();
    return {
      result: { assignmentId: a.id, status },
      audit: {
        action: "assignment.recusal_undone",
        eventId: event.id,
        targetType: "assignment",
        targetId: a.id,
        before: { status: "recused" },
        after: { status, project: a.projectId, judgeUserId: a.judgeUserId, reason },
      },
    };
  });
}

/** Every pair an organizer took back, as the engine's conflicts: no run gives one back. DAL-internal. */
export function takenBackPairs(db: DbOrTx, eventId: string): { judgeId: string; projectId: string }[] {
  return db
    .select({ projectId: auditLog.targetId, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "assignment.remove")))
    .all()
    .flatMap((r) => {
      const judgeId = (r.after as { judgeUserId?: unknown } | null)?.judgeUserId;
      return typeof judgeId === "string" && r.projectId ? [{ judgeId, projectId: r.projectId }] : [];
    });
}

export type ProjectAssignment = {
  id: string;
  judgeId: string;
  judge: string;
  email: string;
  status: "pending" | "done" | "recused";
  /** the judge has saved something on this review */
  started: boolean;
  /** the project is in one of the judge's tracks now, so the review is in their console */
  inTracks: boolean;
  /** still a judge of the event */
  isJudge: boolean;
  byHand: boolean;
  /** the judge's reason, for a recused review */
  recuseReason: string | null;
};

export type ProjectJudging = {
  event: EventRow;
  project: { id: string; title: string; status: string; teamName: string; trackId: string; trackName: string; duplicateOf: string | null };
  tracks: { id: string; name: string }[];
  assignments: ProjectAssignment[];
};

/** One project as its organizers fix its judging: its track, and every judge assigned to it. */
export function getProjectJudging(actor: Actor | null, eventIdOrSlug: string, projectId: string): ProjectJudging {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const project = db
    .select({
      id: projects.id,
      title: projects.title,
      status: projects.status,
      teamName: teams.name,
      trackId: projects.trackId,
      trackName: tracks.name,
      duplicateOf: projects.duplicateOf,
    })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.id, projectId), eq(projects.eventId, event.id)))
    .get();
  if (!project) throw new NotFoundError("Project");
  const rows = db
    .select({
      id: assignments.id,
      judgeId: assignments.judgeUserId,
      judge: users.name,
      email: users.email,
      status: assignments.status,
      scoreId: scores.id,
      params: assignmentRuns.params,
    })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.judgeUserId))
    .innerJoin(assignmentRuns, eq(assignmentRuns.id, assignments.runId))
    .leftJoin(scores, eq(scores.assignmentId, assignments.id))
    .where(eq(assignments.projectId, project.id))
    .orderBy(asc(users.name))
    .all();
  const judgeIds = rows.map((r) => r.judgeId);
  const inTrack = new Set(
    judgeIds.length
      ? db
          .select({ judgeId: judgeTracks.judgeUserId })
          .from(judgeTracks)
          .where(and(eq(judgeTracks.eventId, event.id), eq(judgeTracks.trackId, project.trackId), inArray(judgeTracks.judgeUserId, judgeIds)))
          .all()
          .map((r) => r.judgeId)
      : [],
  );
  const recusals = new Map<string, string>();
  const ids = rows.filter((r) => r.status === "recused").map((r) => r.id);
  if (ids.length) {
    for (const r of db
      .select({ targetId: auditLog.targetId, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, event.id), eq(auditLog.action, "review.recuse"), inArray(auditLog.targetId, ids)))
      .orderBy(desc(auditLog.id))
      .all()) {
      const reason = (r.after as { reason?: unknown } | null)?.reason;
      if (r.targetId && !recusals.has(r.targetId) && typeof reason === "string") recusals.set(r.targetId, reason);
    }
  }
  return {
    event,
    project,
    tracks: db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.position)).all(),
    assignments: rows.map((r) => ({
      id: r.id,
      judgeId: r.judgeId,
      judge: r.judge,
      email: r.email,
      status: r.status,
      started: Boolean(r.scoreId),
      inTracks: inTrack.has(r.judgeId),
      isJudge: isJudgeIn(db, r.judgeId, event.id),
      byHand: Boolean((r.params as { byHand?: unknown } | null)?.byHand),
      recuseReason: recusals.get(r.id) ?? null,
    })),
  };
}
