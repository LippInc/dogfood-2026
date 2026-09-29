import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { compareNames } from "@/lib/names";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignmentRuns, assignments, auditLog, comparisons, judgeOverrides, judgeTracks, projects, scores, teams, tracks, userRoles, users } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { guardRead, mutate, type MutationSpec } from "../mutate";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { answeredPairs, isJudgeIn } from "./judges";
import { parse } from "./parse";
import { newId } from "../util";

// The organizer's audited corrections to the judging set-up: taking back an assignment
// nobody has started, undoing a recusal clicked by mistake, moving a project to another track
// after judges were assigned, and removing a judge. Each asks for a reason,
// writes its audit row in the same transaction, and stops once the results are published,
// when the assignments are final. None of them deletes a saved score.

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
 * with even one score or a word of feedback stays, since it is the judge's work, and so does
 * one whose project they compared in pairwise mode; they
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
    if (
      tx.select({ id: scores.id }).from(scores).where(eq(scores.assignmentId, a.id)).get() ||
      answeredPairs(tx, event.id, a.judgeUserId).has(`${a.judgeUserId}|${a.projectId}`)
    ) {
      throw new ConflictError(
        "review_started",
        "The judge has already saved part of this review or compared this project, so it stays in the record. If the project is not theirs to judge, they declare a conflict in their console.",
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

/** One organizer move of a project to another track, as the published run keeps it. */
export type PublishedTrackMove = { projectId: string; fromTrackId: string; fromTrack: string; toTrackId: string; toTrack: string; reason: string; at: string };

/**
 * Every track move of the event, oldest first, from the audit log, with the tracks' names as
 * they are now: stored with the published run, since the results are grouped by track and a
 * move can change a track's winner. DAL-internal.
 */
export function projectTrackMoves(db: DbOrTx, eventId: string): PublishedTrackMove[] {
  const names = new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => [t.id, t.name]));
  return db
    .select({ projectId: auditLog.targetId, before: auditLog.before, after: auditLog.after, at: auditLog.at })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "project.track_moved")))
    .orderBy(asc(auditLog.id))
    .all()
    .flatMap((r) => {
      const from = (r.before as { trackId?: unknown } | null)?.trackId;
      const after = r.after as { trackId?: unknown; reason?: unknown } | null;
      const to = after?.trackId;
      if (!r.projectId || typeof from !== "string" || typeof to !== "string") return [];
      return [
        {
          projectId: r.projectId,
          fromTrackId: from,
          fromTrack: names.get(from) ?? from,
          toTrackId: to,
          toTrack: names.get(to) ?? to,
          reason: typeof after?.reason === "string" ? after.reason : "",
          at: r.at,
        },
      ];
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
    .all()
    .sort((a, b) => compareNames(a.judge, b.judge));
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
  const answered = answeredPairs(db, event.id);
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
      started: Boolean(r.scoreId) || answered.has(`${r.judgeId}|${project.id}`),
      inTracks: inTrack.has(r.judgeId),
      isJudge: isJudgeIn(db, r.judgeId, event.id),
      byHand: Boolean((r.params as { byHand?: unknown } | null)?.byHand),
      recuseReason: recusals.get(r.id) ?? null,
    })),
  };
}

export const MoveInput = z.object({ trackId: z.string().min(1, "choose a track"), reason: Reason });

export type TrackMove = { moved: boolean; trackId: string; withdrawn: number; finishedKept: number; startedKept: number };

/**
 * Move a project to another track, for a team that picked the wrong one after judges were
 * assigned (the team itself can change it only until then). What happens to its reviews:
 * an open one nobody started, by a judge who does not judge the new track, is withdrawn (it
 * holds nothing); a judge who judges both tracks keeps theirs; a finished review stays and
 * keeps counting, since the rubric is the event's; a started, unfinished one stays in the
 * record but leaves its judge's console. The next top-up gives the project judges from its
 * new track. In pairwise judging, answers that compared it with its old track stop counting.
 */
export function moveProjectTrack(actor: Actor | null, eventIdOrSlug: string, projectId: string, body: unknown): TrackMove {
  let event: EventRow;
  return mutate<TrackMove>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      correctionsOpen(event);
      const input = parse(MoveInput, body);
      const project = tx
        .select({ id: projects.id, trackId: projects.trackId, duplicateOf: projects.duplicateOf })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.eventId, event.id)))
        .get();
      if (!project) throw new NotFoundError("Project");
      const track = tx.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.id, input.trackId), eq(tracks.eventId, event.id))).get();
      if (!track) throw new ValidationError("Check the highlighted fields.", { trackId: ["not a track of this event"] });
      if (project.trackId === track.id) return { result: { moved: false, trackId: track.id, withdrawn: 0, finishedKept: 0, startedKept: 0 }, audit: null };
      if (project.duplicateOf) {
        throw new ConflictError("merged_copy", `This copy is merged into ${project.duplicateOf}, which carries its reviews: move that one instead.`);
      }
      const inNewTrack = new Set(
        tx
          .select({ judgeId: judgeTracks.judgeUserId })
          .from(judgeTracks)
          .where(and(eq(judgeTracks.eventId, event.id), eq(judgeTracks.trackId, track.id)))
          .all()
          .map((r) => r.judgeId),
      );
      const rows = tx
        .select({ id: assignments.id, judgeId: assignments.judgeUserId, status: assignments.status, scoreId: scores.id })
        .from(assignments)
        .leftJoin(scores, eq(scores.assignmentId, assignments.id))
        .where(eq(assignments.projectId, project.id))
        .orderBy(asc(assignments.id))
        .all();
      const answered = answeredPairs(tx, event.id);
      const started = (r: (typeof rows)[number]) => Boolean(r.scoreId) || answered.has(`${r.judgeId}|${project.id}`);
      const leaving = rows.filter((r) => r.status !== "recused" && !inNewTrack.has(r.judgeId));
      const withdrawn = leaving.filter((r) => r.status === "pending" && !started(r));
      const finishedKept = leaving.filter((r) => r.status === "done");
      const startedKept = leaving.filter((r) => r.status === "pending" && started(r));
      if (withdrawn.length) tx.delete(assignments).where(inArray(assignments.id, withdrawn.map((r) => r.id))).run();
      tx.update(projects).set({ trackId: track.id }).where(eq(projects.id, project.id)).run();
      return {
        result: { moved: true, trackId: track.id, withdrawn: withdrawn.length, finishedKept: finishedKept.length, startedKept: startedKept.length },
        audit: {
          action: "project.track_moved",
          eventId: event.id,
          targetType: "project",
          targetId: project.id,
          before: { trackId: project.trackId },
          after: {
            trackId: track.id,
            reason: input.reason,
            withdrawn: withdrawn.map((r) => ({ assignment: r.id, judgeUserId: r.judgeId })),
            finishedKept: finishedKept.map((r) => r.id),
            startedKept: startedKept.map((r) => r.id),
          },
        },
      };
    },
  });
}

export const REMOVED_PREFIX = "Removed as a judge: ";

export type JudgeRemoval = { removed: string; withdrawn: number; kept: number; voided: boolean };

/**
 * Remove a judge from the event, for an invitation accepted by the wrong account or a judge
 * who has to go. Their tracks and judge role end, so the console and every judge route refuse
 * them; open reviews they never started are withdrawn (a top-up fills those seats). Whatever
 * they saved stays in the record, and if they saved anything (a review, a draft, a pairwise
 * answer), an exclusion with the organizer's reason, the same kind the judge ledger shows,
 * leaves it all out of the ranking: the results' receipts name them as removed. Only if they
 * join again (a new invitation) can an organizer count those reviews again, by reinstating them
 * with a reason. Audited as judge.remove; final once the results are published.
 */
export function removeJudge(actor: Actor | null, eventIdOrSlug: string, judgeUserId: string, body: unknown): JudgeRemoval {
  let event: EventRow;
  return mutate<JudgeRemoval>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      correctionsOpen(event);
      const { reason } = parse(CorrectionInput, body);
      if (!isJudgeIn(tx, judgeUserId, event.id)) throw new NotFoundError("Judge");
      const trackIds = tx
        .select({ id: judgeTracks.trackId })
        .from(judgeTracks)
        .where(and(eq(judgeTracks.judgeUserId, judgeUserId), eq(judgeTracks.eventId, event.id)))
        .all()
        .map((t) => t.id)
        .sort();
      const rows = tx
        .select({ id: assignments.id, projectId: assignments.projectId, status: assignments.status, scoreId: scores.id })
        .from(assignments)
        .leftJoin(scores, eq(scores.assignmentId, assignments.id))
        .where(and(eq(assignments.eventId, event.id), eq(assignments.judgeUserId, judgeUserId)))
        .orderBy(asc(assignments.id))
        .all();
      const answered = answeredPairs(tx, event.id, judgeUserId);
      const withdrawn = rows.filter((r) => r.status === "pending" && !r.scoreId && !answered.has(`${judgeUserId}|${r.projectId}`));
      const kept = rows.filter((r) => !withdrawn.includes(r));
      const answers = tx
        .select({ n: sql<number>`count(*)` })
        .from(comparisons)
        .where(and(eq(comparisons.eventId, event.id), eq(comparisons.judgeUserId, judgeUserId)))
        .get()!.n;
      const now = new Date().toISOString();
      // Anything saved is voided from the ranking by an exclusion carrying the reason; nothing is deleted.
      const voided = rows.some((r) => r.scoreId) || answers > 0;
      if (voided) {
        tx.update(judgeOverrides)
          .set({ revokedAt: now, revokedBy: actor!.userId })
          .where(and(eq(judgeOverrides.eventId, event.id), eq(judgeOverrides.judgeUserId, judgeUserId), isNull(judgeOverrides.revokedAt)))
          .run();
        tx.insert(judgeOverrides)
          .values({ id: newId("ovr"), eventId: event.id, judgeUserId, mode: "exclude", reason: `${REMOVED_PREFIX}${reason}`, createdAt: now, createdBy: actor!.userId })
          .run();
      }
      if (withdrawn.length) tx.delete(assignments).where(inArray(assignments.id, withdrawn.map((r) => r.id))).run();
      tx.delete(judgeTracks).where(and(eq(judgeTracks.judgeUserId, judgeUserId), eq(judgeTracks.eventId, event.id))).run();
      tx.delete(userRoles).where(and(eq(userRoles.userId, judgeUserId), eq(userRoles.eventId, event.id), eq(userRoles.role, "judge"))).run();
      return {
        result: { removed: judgeUserId, withdrawn: withdrawn.length, kept: kept.length, voided },
        audit: {
          action: "judge.remove",
          eventId: event.id,
          targetType: "user",
          targetId: judgeUserId,
          before: { trackIds },
          after: {
            reason,
            withdrawn: withdrawn.map((r) => r.id),
            kept: kept.map((r) => r.id),
            pairwiseAnswers: answers,
            voided,
          },
        },
      };
    },
  });
}
