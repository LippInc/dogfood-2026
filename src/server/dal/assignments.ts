import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignmentRuns, assignments, judgeTracks, projects, teamMembers, tracks, users } from "../db/schema";
import { appendAudit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assignJudges, type AssignInput, type AssignResult } from "../judging/assign";
import { newSeed } from "../judging/random";
import { guardRead, mutate } from "../mutate";
import { newId } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { isJudgeIn, judgeRows } from "./judges";
import { inJudgeTracks, judgeSet } from "./judging";
import { parse } from "./parse";
import { shownTitle } from "./project-fields";
import { takenBackPairs } from "./corrections";

// Assignment runs: the organizer starts a fresh run once,
// then top-ups as judges join, reviews go missing or a judge is excluded. Every run
// stores its seed and parameters, so it can be replayed; every pair it creates
// records the run. An under-reviewed project gets a judge only by an organizer's
// hand, with a reason, never across tracks automatically.

export const DEFAULT_REVIEWS_PER_PROJECT = 3;
export const DEFAULT_BRIDGE_PER_TRACK = 2;

export const RunInput = z.object({
  mode: z.enum(["fresh", "topup"]),
  seed: z.coerce.number().int().min(1).max(2 ** 31 - 2).optional(),
  reviewsPerProject: z.coerce.number().int().min(1).max(10).optional(),
  bridgePerTrack: z.coerce.number().int().min(0).max(5).optional(),
  maxPerJudge: z.coerce.number().int().min(1).max(500).nullable().optional(),
});

export const ManualInput = z.object({
  projectId: z.string().min(1),
  judgeUserId: z.string().min(1),
  reason: z.string().trim().min(3, "say why, in a few words").max(500),
});

/** The engine's input for an event as it stands: submitted, unmerged projects only. */
function engineInput(db: DbOrTx, event: EventRow): Omit<AssignInput, keyof import("../judging/assign").AssignParams> {
  const projectRows = db
    .select({ id: projects.id, trackId: projects.trackId, teamId: projects.teamId })
    .from(projects)
    .where(and(eq(projects.eventId, event.id), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .all();
  const judges = judgeRows(db, event.id).map((j) => ({ id: j.id, trackIds: j.tracks.map((t) => t.id) }));
  const judgeIds = new Set(judges.map((j) => j.id));
  // A judge on a project's team never reviews it; neither does a judge who recused, nor one an organizer took the project from.
  const members = db
    .select({ teamId: teamMembers.teamId, userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.eventId, event.id))
    .all()
    .filter((m) => judgeIds.has(m.userId));
  const existing = db
    .select({ judgeId: assignments.judgeUserId, projectId: assignments.projectId, status: assignments.status, visible: inJudgeTracks })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .where(eq(assignments.eventId, event.id))
    .all();
  const excluded = judgeSet(db, event.id).excluded;
  const conflicts = [
    ...projectRows.flatMap((p) => members.filter((m) => m.teamId === p.teamId).map((m) => ({ judgeId: m.userId, projectId: p.id }))),
    ...existing.filter((e) => e.status === "recused").map(({ judgeId, projectId }) => ({ judgeId, projectId })),
    // a pair an organizer took back stays taken back: only an organizer's hand gives it again
    ...takenBackPairs(db, event.id),
  ];
  return {
    projects: projectRows.map(({ id, trackId }) => ({ id, trackId })),
    judges,
    conflicts,
    // A seat is filled by a finished review, or by an open one its judge can still finish: an open
    // review of a project outside the judge's tracks now (the team or an organizer moved it, or the
    // judge lost the track) never reaches the judge's console, so a top-up gives the project another.
    existing: existing.map((e) => ({
      judgeId: e.judgeId,
      projectId: e.projectId,
      counts: (e.status === "done" || (e.status === "pending" && Boolean(e.visible))) && !excluded.includes(e.judgeId),
    })),
    excludedJudges: excluded,
  };
}

export type RunSummary = {
  runId: string;
  mode: "fresh" | "topup";
  seed: number;
  added: number;
  underReviewed: AssignResult["underReviewed"];
  short: AssignResult["short"];
  bridge: AssignResult["bridge"];
};

/** Once the results are published nobody new is assigned: those reviews could never be scored. */
function assignmentsOpen(event: EventRow) {
  if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so the assignments are final.");
}

export function runAssignment(actor: Actor | null, eventIdOrSlug: string, body: unknown): RunSummary {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      assignmentsOpen(event);
      const input = parse(RunInput, body);
      const hasAny = tx.select({ n: sql<number>`count(*)` }).from(assignments).where(eq(assignments.eventId, event.id)).get()!.n > 0;
      if (input.mode === "fresh" && hasAny) {
        throw new ConflictError(
          "assignments_exist",
          "This event already has assignments. Run a top-up instead: it keeps every existing pair and fills only the missing reviews.",
        );
      }
      const params = {
        mode: input.mode,
        seed: input.seed ?? newSeed(),
        reviewsPerProject: input.reviewsPerProject ?? event.settings.reviewsPerProject ?? DEFAULT_REVIEWS_PER_PROJECT,
        bridgePerTrack: input.mode === "fresh" ? (input.bridgePerTrack ?? DEFAULT_BRIDGE_PER_TRACK) : 0,
        maxPerJudge: input.maxPerJudge ?? null,
      };
      const data = engineInput(tx, event);
      const out = assignJudges({ ...params, ...data });

      const now = new Date().toISOString();
      const runId = newId("run");
      tx.insert(assignmentRuns)
        .values({
          id: runId,
          eventId: event.id,
          mode: params.mode,
          seed: params.seed,
          params: {
            reviewsPerProject: params.reviewsPerProject,
            bridgePerTrack: params.bridgePerTrack,
            maxPerJudge: params.maxPerJudge,
            excludedJudges: data.excludedJudges,
            added: out.pairs.length,
            underReviewed: out.underReviewed,
            short: out.short,
            bridge: out.bridge,
          },
          createdAt: now,
          createdBy: actor!.userId,
        })
        .run();
      insertOrdered(tx, event.id, runId, out.order, now);
      return {
        result: { runId, mode: params.mode, seed: params.seed, added: out.pairs.length, underReviewed: out.underReviewed, short: out.short, bridge: out.bridge },
        audit: {
          action: "assignment.run",
          eventId: event.id,
          targetType: "assignment_run",
          targetId: runId,
          after: {
            mode: params.mode,
            seed: params.seed,
            reviewsPerProject: params.reviewsPerProject,
            bridgePerTrack: params.bridgePerTrack,
            added: out.pairs.length,
            underReviewed: out.underReviewed.map((u) => u.projectId),
          },
        },
      };
    },
  });
}

/** Store each judge's new pairs after their existing ones, in the run's seeded order. */
function insertOrdered(tx: DbOrTx, eventId: string, runId: string, order: Record<string, string[]>, now: string) {
  for (const [judgeId, projectIds] of Object.entries(order)) {
    const last = tx
      .select({ batch: sql<number | null>`max(${assignments.batchNo})`, position: sql<number | null>`max(${assignments.position})` })
      .from(assignments)
      .where(and(eq(assignments.eventId, eventId), eq(assignments.judgeUserId, judgeId)))
      .get();
    const batchNo = (last?.batch ?? 0) + 1;
    projectIds.forEach((projectId, i) => {
      tx.insert(assignments)
        .values({ id: newId("asg"), eventId, judgeUserId: judgeId, projectId, runId, batchNo, position: (last?.position ?? -1) + 1 + i, status: "pending", createdAt: now })
        .run();
    });
  }
}

/**
 * The organizer gives an under-reviewed project one more judge by hand, with a
 * reason. Choosing a judge from another track also adds this track to that judge,
 * in the same transaction, so no judge ever sees a project outside their tracks.
 * That widens the judge's reach to the whole track (later top-ups, pairwise
 * questions), so the grant is its own audit row: a judge.tracks row naming the
 * hand assignment, the project and the reason, next to the assignment's row.
 * (Assigning without the track would need an exception to the one track rule
 * authorize() applies to every review, which stays as it is.)
 */
export function assignByHand(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      assignmentsOpen(event);
      const input = parse(ManualInput, body);
      const project = tx
        .select({ id: projects.id, teamId: projects.teamId, trackId: projects.trackId, status: projects.status })
        .from(projects)
        .where(and(eq(projects.id, input.projectId), eq(projects.eventId, event.id)))
        .get();
      if (!project || project.status !== "submitted") throw new NotFoundError("Submitted project");
      if (!isJudgeIn(tx, input.judgeUserId, event.id)) throw new ValidationError("Check the highlighted fields.", { judgeUserId: ["not a judge in this event"] });
      const onTeam = tx
        .select({ u: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, project.teamId), eq(teamMembers.userId, input.judgeUserId)))
        .get();
      if (onTeam) throw new ConflictError("conflict_of_interest", "This judge is on the project's team.");
      const already = tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.judgeUserId, input.judgeUserId), eq(assignments.projectId, project.id)))
        .get();
      if (already) throw new ConflictError("already_assigned", "This judge already has this project.");
      const inTrack = Boolean(
        tx
          .select({ t: judgeTracks.trackId })
          .from(judgeTracks)
          .where(and(eq(judgeTracks.judgeUserId, input.judgeUserId), eq(judgeTracks.trackId, project.trackId)))
          .get(),
      );
      const now = new Date().toISOString();
      if (!inTrack) {
        const before = tx
          .select({ id: judgeTracks.trackId })
          .from(judgeTracks)
          .where(and(eq(judgeTracks.judgeUserId, input.judgeUserId), eq(judgeTracks.eventId, event.id)))
          .all()
          .map((t) => t.id)
          .sort();
        tx.insert(judgeTracks).values({ judgeUserId: input.judgeUserId, eventId: event.id, trackId: project.trackId }).onConflictDoNothing().run();
        appendAudit(
          tx,
          {
            actorUserId: actor!.userId,
            actorLabel: actor!.name,
            action: "judge.tracks",
            eventId: event.id,
            targetType: "user",
            targetId: input.judgeUserId,
            before: { trackIds: before },
            after: { trackIds: [...before, project.trackId].sort(), via: "assignment.by_hand", project: project.id, reason: input.reason },
          },
          now,
        );
      }
      const addedTrack = inTrack ? null : project.trackId;
      const runId = newId("run");
      tx.insert(assignmentRuns)
        .values({
          id: runId,
          eventId: event.id,
          mode: "topup",
          seed: 0,
          params: { byHand: true, projectId: project.id, judgeUserId: input.judgeUserId, inTrack, addedTrack, reason: input.reason },
          createdAt: now,
          createdBy: actor!.userId,
        })
        .run();
      insertOrdered(tx, event.id, runId, { [input.judgeUserId]: [project.id] }, now);
      return {
        result: { runId },
        audit: {
          action: "assignment.by_hand",
          eventId: event.id,
          targetType: "project",
          targetId: project.id,
          after: { judgeUserId: input.judgeUserId, inTrack, addedTrack, reason: input.reason },
        },
      };
    },
  });
}

export type RunRow = {
  id: string;
  mode: string;
  seed: number;
  createdAt: string;
  createdBy: string | null;
  params: Record<string, unknown>;
  pairs: number;
};

/** The organizer's assignment view: runs, coverage per project, what a top-up would do. */
export function getAssignments(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const runs: RunRow[] = db
    .select({
      id: assignmentRuns.id,
      mode: assignmentRuns.mode,
      seed: assignmentRuns.seed,
      createdAt: assignmentRuns.createdAt,
      createdBy: users.name,
      params: assignmentRuns.params,
      pairs: sql<number>`(select count(*) from ${assignments} a where a.run_id = ${assignmentRuns.id})`,
    })
    .from(assignmentRuns)
    .leftJoin(users, eq(users.id, assignmentRuns.createdBy))
    .where(eq(assignmentRuns.eventId, event.id))
    .orderBy(desc(assignmentRuns.createdAt))
    .all();
  const data = engineInput(db, event);
  const target = event.settings.reviewsPerProject ?? DEFAULT_REVIEWS_PER_PROJECT;
  // A dry top-up with a fixed seed: what the next run would add, without storing it.
  const preview = assignJudges({ mode: "topup", seed: 1, reviewsPerProject: target, bridgePerTrack: 0, maxPerJudge: null, ...data });
  const trackNames = new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).all().map((t) => [t.id, t.name]));
  const titles = new Map(
    db.select({ id: projects.id, title: shownTitle() }).from(projects).where(eq(projects.eventId, event.id)).all().map((p) => [p.id, p.title]),
  );
  return {
    event,
    runs,
    target,
    projects: data.projects.length,
    judges: data.judges.length,
    hasAssignments: data.existing.length > 0,
    wouldAdd: preview.pairs.length,
    underReviewed: preview.underReviewed.map((u) => {
      const trackId = data.projects.find((p) => p.id === u.projectId)!.trackId;
      return { ...u, title: titles.get(u.projectId) ?? u.projectId, trackId, track: trackNames.get(trackId) ?? "" };
    }),
    short: preview.short.map((s) => ({ ...s, title: titles.get(s.projectId) ?? s.projectId })),
  };
}
