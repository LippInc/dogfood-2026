import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { compareNames } from "@/lib/names";
import { competitionPlaceOf } from "@/lib/places";
import type { Actor } from "../authz";
import { toCsv } from "../csv";
import { getDb, type DbOrTx, type Tx } from "../db/client";
import { assignments, auditLog, finalists, finals, finalsPanel, finalsScoreItems, finalsScores, judgeOverrides, projects, teamMembers, teams, tracks, userRoles, users } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { newId } from "../util";
import { notPublished } from "./decisions";
import { eventFacts, organizerMutation, requireEvent, type EventRow } from "./events";
import { rubricOf, weightedTotal, type Criterion } from "./judging";
import { computeNormalization } from "./normalization";
import { computePairwise, judgingModeOf } from "./pairwise";
import { parse } from "./parse";
import { shownTitle } from "./project-fields";

// The finals (JUDGING.md, "Finals"): a second round for one track or every track. The organizer opens it with the
// top N of each track by first-round places suggested as finalists, may add or take off a finalist (with a reason
// when that goes against the ranking), names a panel of at least two of the event's judges, and closes it once
// every counted panelist has scored every finalist they are free to score (or earlier, or with fewer than two counted
// panelists, with a reason). A finalist's finals score is the plain mean of the counted panelists' weighted totals,
// with a ± of one standard error; with every panelist scoring every finalist no leniency correction is needed.
// The published places of a track then put its finalists first, in the finals order, and everyone else after them
// in first-round order (getPublishedResults). The first round's tables and rules are not touched.

const Reason = z.string().trim().min(3, "say why, in a few words").max(500);

export const OpenFinalsInput = z.object({
  track: z.string().min(1).nullable().optional().describe("the track's id; left out or null: one finals round for every track"),
  n: z.number().int().min(1).max(50).default(3).describe("how many per track to suggest as finalists: the top N by first-round places (ties at the cut all go in)"),
});
export const FinalistInput = z.object({
  project: z.string().min(1),
  reason: Reason.optional().describe("needed when the project is not in its track's suggested top N (422 reason_needed without it)"),
});
export const RemoveFinalistInput = z.object({
  reason: Reason.optional().describe("needed when the project is in its track's suggested top N (422 reason_needed without it)"),
});
export const PanelInput = z.object({
  judges: z.array(z.string().min(1)).min(2, "a panel needs at least two judges").max(50).describe("the user ids of the event's judges on the panel"),
  reason: Reason.optional().describe("needed once any finals score exists in the round (422 reason_needed without it): a panelist taken off loses their scores from the finals order"),
});
export const CloseFinalsInput = z.object({
  reason: Reason.optional().describe("needed when a panelist has not scored every finalist yet (409 finals_incomplete without it)"),
});
export const FinalsScoreInput = z.object({
  finals: z.string().min(1),
  project: z.string().min(1),
  values: z.record(z.string(), z.number().int()).describe("one whole number per rubric criterion, keyed by the criterion's key, within its scale"),
});

type FinalsRow = typeof finals.$inferSelect;

// ---------------------------------------------------------------------------
// The first round's places, before publishing (the suggestion reads them)
// ---------------------------------------------------------------------------

export type RoundOneRow = { id: string; title: string; trackId: string; trackName: string; place: number | null };

/** Each kept project's place in its track by the live first-round ranking: the score engine's, or the pairwise fit's. */
export function roundOnePlaces(db: DbOrTx, event: EventRow): RoundOneRow[] {
  if (judgingModeOf(event) === "pairwise") {
    const pw = computePairwise(db, event);
    const info = new Map(
      db
        .select({ id: projects.id, title: shownTitle(), trackName: tracks.name })
        .from(projects)
        .innerJoin(tracks, eq(tracks.id, projects.trackId))
        .innerJoin(teams, eq(teams.id, projects.teamId))
        .where(eq(projects.eventId, event.id))
        .all()
        .map((p) => [p.id, p]),
    );
    return pw.fit.projects
      .filter((p) => info.has(p.id))
      .map((p) => ({ id: p.id, title: info.get(p.id)!.title, trackId: p.trackId, trackName: info.get(p.id)!.trackName, place: p.comparisons > 0 ? p.place : null }));
  }
  const n = computeNormalization(db, event);
  const kept = n.projects.filter((p) => !p.duplicateOf);
  const out: RoundOneRow[] = [];
  for (const trackId of [...new Set(kept.map((p) => p.trackId))]) {
    const rows = kept.filter((p) => p.trackId === trackId);
    const places = competitionPlaceOf(new Map(rows.filter((p) => p.score !== null).map((p) => [p.id, p.score!])));
    for (const p of rows) out.push({ id: p.id, title: p.title, trackId, trackName: p.trackName, place: places.get(p.id) ?? null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The finals order: the plain mean of the panelists' weighted totals
// ---------------------------------------------------------------------------

export type FinalsStanding = {
  projectId: string;
  score: number | null;
  /** one standard error of the finals score (standardError); null with fewer than two counted panelists */
  se: number | null;
  n: number;
  /** the plain mean per criterion id over the same counted scores: the tie-break reads its criterion here */
  criteria: Record<string, number>;
};

type ScoreLine = { id: string; finalsId: string; projectId: string; judgeUserId: string; savedAt: string; values: Map<string, number> };

function scoreLines(db: DbOrTx, finalsIds: string[]): ScoreLine[] {
  if (!finalsIds.length) return [];
  const rows = db.select().from(finalsScores).where(inArray(finalsScores.finalsId, finalsIds)).orderBy(asc(finalsScores.savedAt), asc(finalsScores.id)).all();
  const items = rows.length ? db.select().from(finalsScoreItems).where(inArray(finalsScoreItems.finalsScoreId, rows.map((r) => r.id))).all() : [];
  const byScore = new Map<string, Map<string, number>>();
  for (const it of items) byScore.set(it.finalsScoreId, (byScore.get(it.finalsScoreId) ?? new Map()).set(it.criterionId, it.value));
  return rows.map((r) => ({ id: r.id, finalsId: r.finalsId, projectId: r.projectId, judgeUserId: r.judgeUserId, savedAt: r.savedAt, values: byScore.get(r.id) ?? new Map() }));
}

/** A score's weighted total over the rubric, or null when it lacks a criterion (the rubric changed after it was saved). */
function totalOf(criteria: Criterion[], values: Map<string, number>): number | null {
  if (!criteria.length || criteria.some((c) => !values.has(c.id))) return null;
  return weightedTotal(criteria, criteria.map((c) => values.get(c.id)!));
}

/**
 * Exported for tests. Each finalist's finals score: the plain mean of the weighted totals of the panelists on the
 * panel now (a score by someone taken off the panel does not count), with how many there were; null with none.
 */
export function finalsStandings(
  finalistIds: string[],
  panel: Set<string>,
  lines: { projectId: string; judgeUserId: string; total: number | null; values?: Map<string, number> }[],
): FinalsStanding[] {
  return finalistIds.map((projectId) => {
    const counted = lines.filter((l) => l.projectId === projectId && panel.has(l.judgeUserId) && l.total !== null);
    const totals = counted.map((l) => l.total!);
    const criteria: Record<string, number> = {};
    for (const id of new Set(counted.flatMap((l) => [...(l.values?.keys() ?? [])]))) {
      const xs = counted.flatMap((l) => (l.values?.has(id) ? [l.values.get(id)!] : []));
      criteria[id] = xs.reduce((a, b) => a + b, 0) / xs.length;
    }
    return { projectId, score: totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null, se: standardError(totals), n: totals.length, criteria };
  });
}

/**
 * The ± on a finals score: the standard error of the mean of the panelists' totals, their sample standard deviation
 * (n − 1) divided by √n; null with fewer than two totals, where nothing measures the spread (JUDGING.md, "Finals").
 */
export function standardError(totals: number[]): number | null {
  const n = totals.length;
  if (n < 2) return null;
  const mean = totals.reduce((a, b) => a + b, 0) / n;
  const variance = totals.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance) / Math.sqrt(n);
}

/** Why a panelist may not score a finalist: their own team's project, or one they declared a conflict on in the first round. */
export type FinalsConflict = "own_team" | "recused";

/**
 * Each panelist-finalist pair with a conflict of interest, keyed `judge|project`: the judge is a member of the
 * project's team (the first round never gives a judge their own team's project), or recused themselves from it in the
 * first round (a declared conflict). Such a pair is never scored and never waited for.
 */
export function finalsConflicts(db: DbOrTx, eventId: string, judgeUserId?: string, projectId?: string): Map<string, FinalsConflict> {
  const out = new Map<string, FinalsConflict>();
  const own = db
    .select({ projectId: projects.id, userId: teamMembers.userId })
    .from(projects)
    .innerJoin(teamMembers, eq(teamMembers.teamId, projects.teamId))
    .where(and(eq(projects.eventId, eventId), ...(judgeUserId ? [eq(teamMembers.userId, judgeUserId)] : []), ...(projectId ? [eq(projects.id, projectId)] : [])))
    .all();
  for (const r of own) out.set(`${r.userId}|${r.projectId}`, "own_team");
  const recused = db
    .select({ projectId: assignments.projectId, userId: assignments.judgeUserId })
    .from(assignments)
    .where(
      and(
        eq(assignments.eventId, eventId),
        eq(assignments.status, "recused"),
        ...(judgeUserId ? [eq(assignments.judgeUserId, judgeUserId)] : []),
        ...(projectId ? [eq(assignments.projectId, projectId)] : []),
      ),
    )
    .all();
  for (const r of recused) if (!out.has(`${r.userId}|${r.projectId}`)) out.set(`${r.userId}|${r.projectId}`, "recused");
  return out;
}

/**
 * Panelists whose finals scores stay on record but out of the finals order, as the first round treats them: removed
 * from the event's judges (judge.remove), or left out by the organizer (an exclude override, judge.override).
 */
export function finalsLeftOut(db: DbOrTx, eventId: string): Map<string, "removed" | "left_out"> {
  const judges = new Set(db.select({ id: userRoles.userId }).from(userRoles).where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge"))).all().map((r) => r.id));
  const excluded = db
    .select({ id: judgeOverrides.judgeUserId })
    .from(judgeOverrides)
    .where(and(eq(judgeOverrides.eventId, eventId), eq(judgeOverrides.mode, "exclude"), isNull(judgeOverrides.revokedAt)))
    .all()
    .map((r) => r.id);
  const panel = db.select({ id: finalsPanel.judgeUserId }).from(finalsPanel).where(eq(finalsPanel.eventId, eventId)).all().map((r) => r.id);
  const out = new Map<string, "removed" | "left_out">();
  for (const j of panel) if (!judges.has(j)) out.set(j, "removed");
  for (const j of excluded) if (!out.has(j)) out.set(j, "left_out");
  return out;
}

type Round = {
  row: FinalsRow;
  finalists: (typeof finalists.$inferSelect)[];
  panel: string[];
  /** the panelists whose scores count: the panel less anyone removed or left out */
  counted: string[];
  standings: FinalsStanding[];
  /** counted panelist × finalist pairs with no counted score yet, a pair with a conflict of interest not included */
  missing: number;
  /** the pairs with a conflict of interest in this round, `judge|project` */
  conflicts: Map<string, FinalsConflict>;
};

function rounds(db: DbOrTx, eventId: string): Round[] {
  const rows = db.select().from(finals).where(eq(finals.eventId, eventId)).orderBy(asc(finals.openedAt), asc(finals.id)).all();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const fin = db.select().from(finalists).where(inArray(finalists.finalsId, ids)).orderBy(asc(finalists.addedAt), asc(finalists.projectId)).all();
  const pan = db.select().from(finalsPanel).where(inArray(finalsPanel.finalsId, ids)).all();
  const criteria = rubricOf(db, eventId);
  const allConflicts = finalsConflicts(db, eventId);
  const out = finalsLeftOut(db, eventId);
  // a score on a pair with a conflict of interest never counts, whenever the conflict arose
  const lines = scoreLines(db, ids)
    .filter((l) => !allConflicts.has(`${l.judgeUserId}|${l.projectId}`))
    .map((l) => ({ ...l, total: totalOf(criteria, l.values) }));
  return rows.map((row) => {
    const mine = fin.filter((f) => f.finalsId === row.id);
    const panel = pan.filter((p) => p.finalsId === row.id).map((p) => p.judgeUserId);
    const counted = panel.filter((j) => !out.has(j));
    const own = lines.filter((l) => l.finalsId === row.id);
    const standings = finalsStandings(mine.map((f) => f.projectId), new Set(counted), own);
    const conflicts = new Map([...allConflicts].filter(([k]) => panel.includes(k.split("|")[0]!) && mine.some((f) => f.projectId === k.split("|")[1])));
    let missing = 0;
    for (const f of mine) {
      for (const j of counted) {
        if (conflicts.has(`${j}|${f.projectId}`)) continue;
        if (!own.some((l) => l.projectId === f.projectId && l.judgeUserId === j && l.total !== null)) missing++;
      }
    }
    return { row, finalists: mine, panel, counted, standings, missing, conflicts };
  });
}

/**
 * What the published results read: per track, its finalists' finals scores, from closed rounds only (publishing
 * refuses while one is open). Empty for an event with no finals, so its results stay exactly as they were.
 */
export type PublishedFinals = {
  rounds: {
    trackId: string | null;
    closedAt: string;
    closeReason: string | null;
    /** the panelists whose scores count (the panel less anyone removed or left out) */
    panel: number;
    /** counted panelist × finalist pairs left unscored at the close (a round closed early) */
    missing: number;
    finalists: number;
    /** panelists on the panel whose finals scores are out of the order: removed from the judges or left out */
    leftOut: number;
    /** panelist-finalist pairs not scored for a conflict of interest (own team, or declared in the first round) */
    conflicts: number;
    /** each change of the panel after a finals score existed, with the organizer's reason */
    panelChanges: { at: string; reason: string; added: number; removed: number }[];
    /** each finalist the organizer added or took off against the first-round ranking, with their reason (finalistChanges) */
    finalistChanges: FinalistChange[];
  }[];
  /** trackId -> projectId -> the finalist's finals score */
  byTrack: Map<string, Map<string, FinalsStanding>>;
};

export function publishedFinals(db: DbOrTx, eventId: string): PublishedFinals | null {
  const closed = rounds(db, eventId).filter((r) => r.row.closedAt);
  if (!closed.length) return null;
  const trackOf = new Map(db.select({ id: projects.id, trackId: projects.trackId }).from(projects).where(eq(projects.eventId, eventId)).all().map((p) => [p.id, p.trackId]));
  const byTrack = new Map<string, Map<string, FinalsStanding>>();
  for (const r of closed) {
    for (const s of r.standings) {
      const t = trackOf.get(s.projectId);
      if (!t || (r.row.trackId && r.row.trackId !== t)) continue;
      byTrack.set(t, (byTrack.get(t) ?? new Map()).set(s.projectId, s));
    }
  }
  return {
    rounds: closed.map((r) => ({
      trackId: r.row.trackId,
      closedAt: r.row.closedAt!,
      closeReason: r.row.closeReason,
      panel: r.counted.length,
      missing: r.missing,
      finalists: r.finalists.length,
      leftOut: r.panel.length - r.counted.length,
      conflicts: r.conflicts.size,
      panelChanges: panelChanges(db, r.row.id),
      finalistChanges: finalistChanges(db, r.row.id, new Set(r.finalists.map((f) => f.projectId)), r.finalists),
    })),
    byTrack,
  };
}

export type FinalistChange = { projectId: string; change: "added" | "removed"; reason: string; at: string };

/**
 * A round's finalists that go against the first-round ranking, each with the organizer's reason: those added from
 * outside the track's top N (the reason stored on the finalist) and those in the top N taken off (the reason in the
 * audit row of the removal; one added back since is a finalist again and not listed as taken off). Oldest first.
 */
export function finalistChanges(db: DbOrTx, finalsId: string, now: Set<string>, rows: { projectId: string; reason: string | null; addedAt: string }[]): FinalistChange[] {
  const added = rows.flatMap((f) => (f.reason ? [{ projectId: f.projectId, change: "added" as const, reason: f.reason, at: f.addedAt }] : []));
  const removed = db
    .select({ at: auditLog.at, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, "finals.finalist_remove"), eq(auditLog.targetType, "finals"), eq(auditLog.targetId, finalsId)))
    .orderBy(asc(auditLog.id))
    .all()
    .flatMap((a) => {
      const project = ((a.before ?? {}) as { project?: string }).project;
      const reason = ((a.after ?? {}) as { reason?: string }).reason;
      return project && reason && !now.has(project) ? [{ projectId: project, change: "removed" as const, reason, at: a.at }] : [];
    });
  // the last removal of a project stands for it
  const last = new Map(removed.map((r) => [r.projectId, r]));
  return [...added, ...last.values()].sort((a, b) => a.at.localeCompare(b.at) || a.projectId.localeCompare(b.projectId));
}

/** A round's panel changes that carried a reason (made after a finals score existed), from its audit rows. */
export function panelChanges(db: DbOrTx, finalsId: string): { at: string; reason: string; added: number; removed: number }[] {
  return db
    .select({ at: auditLog.at, before: auditLog.before, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.action, "finals.panel"), eq(auditLog.targetType, "finals"), eq(auditLog.targetId, finalsId)))
    .orderBy(asc(auditLog.id))
    .all()
    .flatMap((a) => {
      const after = (a.after ?? {}) as { panel?: string[]; reason?: string };
      const before = (a.before ?? {}) as { panel?: string[] };
      if (!after.reason) return [];
      const was = new Set(before.panel ?? []);
      const now = new Set(after.panel ?? []);
      return [{ at: a.at, reason: after.reason, added: [...now].filter((j) => !was.has(j)).length, removed: [...was].filter((j) => !now.has(j)).length }];
    });
}

/**
 * The tracks whose top places come from a finals round, open or closed: a one-track round's track, and for a round
 * over every track the tracks of its finalists. Such a track needs no judges' decision on a close call: its panel
 * decides the top places (the published order: tie-break, finals, then the judges' decision).
 */
export function finalsTrackIds(db: DbOrTx, eventId: string): Set<string> {
  const rows = db.select({ id: finals.id, trackId: finals.trackId }).from(finals).where(eq(finals.eventId, eventId)).all();
  const out = new Set<string>();
  for (const r of rows) if (r.trackId) out.add(r.trackId);
  const every = rows.filter((r) => !r.trackId).map((r) => r.id);
  if (every.length) {
    const ids = db.select({ trackId: projects.trackId }).from(finalists).innerJoin(projects, eq(projects.id, finalists.projectId)).where(inArray(finalists.finalsId, every)).all();
    for (const r of ids) out.add(r.trackId);
  }
  return out;
}

/** Publishing waits for every finals round to be closed. */
export function finalsOpenCount(db: DbOrTx, eventId: string): number {
  return db.select({ id: finals.id, closedAt: finals.closedAt }).from(finals).where(eq(finals.eventId, eventId)).all().filter((r) => !r.closedAt).length;
}

// ---------------------------------------------------------------------------
// The organizer: open, finalists, panel, close
// ---------------------------------------------------------------------------

function requireRound(tx: DbOrTx, event: EventRow, finalsId: string): FinalsRow {
  const row = tx.select().from(finals).where(and(eq(finals.id, finalsId), eq(finals.eventId, event.id))).get();
  if (!row) throw new NotFoundError("Finals round");
  return row;
}

function stillOpen(row: FinalsRow) {
  if (row.closedAt) throw new ConflictError("finals_closed", "These finals are closed, so the finalists, the panel and the scores are final.");
}

/** The suggestion's cut for a round: the projects of its track(s) at a first-round place of N or better. */
function inTopN(event: EventRow, tx: DbOrTx, row: FinalsRow): Map<string, RoundOneRow> {
  return new Map(
    roundOnePlaces(tx, event)
      .filter((p) => (row.trackId === null || p.trackId === row.trackId) && p.place !== null && p.place <= row.suggested)
      .map((p) => [p.id, p]),
  );
}

export function openFinals(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const input = parse(OpenFinalsInput, body ?? {});
    const trackId = input.track ?? null;
    // a pairwise event has no rubric scores in its first round, so nothing would lock the rubric the finals score on
    if (judgingModeOf(event) === "pairwise") {
      throw new ConflictError("pairwise_mode", "Finals score finalists on the rubric, and this event judges pairwise. Switch it to scores to hold finals.");
    }
    if (Date.now() < Date.parse(event.submissionsCloseAt)) {
      throw new ConflictError("submissions_open", "Finals follow the first round, which starts when submissions close.");
    }
    if (trackId && !tx.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.id, trackId), eq(tracks.eventId, event.id))).get()) {
      throw new ValidationError("That track is not in this event.", { track: ["not a track of this event"] });
    }
    const existing = tx.select({ trackId: finals.trackId }).from(finals).where(eq(finals.eventId, event.id)).all();
    if (existing.some((f) => f.trackId === null || trackId === null || f.trackId === trackId)) {
      throw new ConflictError("finals_exist", trackId === null ? "This event already has finals; one round covers a track once." : "This track already has finals.");
    }
    const at = new Date().toISOString();
    const id = newId("fin");
    tx.insert(finals).values({ id, eventId: event.id, trackId, suggested: input.n, openedAt: at, openedBy: actor!.userId }).run();
    const row = requireRound(tx, event, id);
    const top = [...inTopN(event, tx, row).values()];
    if (top.length < 2) throw new ConflictError("too_few_ranked", "Finals need at least two projects with a first-round place.");
    for (const p of top) tx.insert(finalists).values({ finalsId: id, eventId: event.id, projectId: p.id, reason: null, addedAt: at, addedBy: actor!.userId }).run();
    return {
      result: { id, track: trackId, n: input.n, finalists: top.map((p) => p.id) },
      audit: { action: "finals.open", eventId: event.id, targetType: "finals", targetId: id, after: { track: trackId, n: input.n, finalists: top.map((p) => ({ project: p.id, place: p.place })) } },
    };
  });
}

export function addFinalist(actor: Actor | null, eventIdOrSlug: string, finalsId: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const row = requireRound(tx, event, finalsId);
    stillOpen(row);
    const input = parse(FinalistInput, body ?? {});
    const p = tx
      .select({ id: projects.id, trackId: projects.trackId, status: projects.status, duplicateOf: projects.duplicateOf })
      .from(projects)
      .where(and(eq(projects.id, input.project), eq(projects.eventId, event.id)))
      .get();
    if (!p || p.status !== "submitted" || p.duplicateOf) throw new ValidationError("That project is not a submitted project of this event.", { project: ["not a submitted project here"] });
    if (row.trackId && p.trackId !== row.trackId) throw new ValidationError("That project is in another track.", { project: ["in another track"] });
    if (tx.select({ id: finalists.projectId }).from(finalists).where(and(eq(finalists.finalsId, row.id), eq(finalists.projectId, p.id))).get()) {
      return { result: { project: p.id, added: false }, audit: null };
    }
    const top = inTopN(event, tx, row);
    // adding one the ranking did not put in the top N goes against it: that needs the organizer's reason
    if (!top.has(p.id) && !input.reason) throw new ValidationError("Say why this project goes to the finals: it is not in its track's top " + row.suggested + ".", { reason: ["reason_needed"] });
    const reason = top.has(p.id) ? null : input.reason!;
    tx.insert(finalists).values({ finalsId: row.id, eventId: event.id, projectId: p.id, reason, addedAt: new Date().toISOString(), addedBy: actor!.userId }).run();
    return {
      result: { project: p.id, added: true },
      audit: { action: "finals.finalist_add", eventId: event.id, targetType: "finals", targetId: row.id, after: { project: p.id, ...(reason ? { reason } : {}) } },
    };
  });
}

export function removeFinalist(actor: Actor | null, eventIdOrSlug: string, finalsId: string, projectId: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const row = requireRound(tx, event, finalsId);
    stillOpen(row);
    const input = parse(RemoveFinalistInput, body ?? {});
    const f = tx.select().from(finalists).where(and(eq(finalists.finalsId, row.id), eq(finalists.projectId, projectId))).get();
    if (!f) throw new NotFoundError("Finalist");
    const top = inTopN(event, tx, row);
    // taking off one the ranking put in the top N goes against it: that needs the organizer's reason
    if (top.has(projectId) && !input.reason) throw new ValidationError("Say why this project leaves the finals: it is in its track's top " + row.suggested + ".", { reason: ["reason_needed"] });
    const left = tx.select({ id: finalists.projectId }).from(finalists).where(eq(finalists.finalsId, row.id)).all().length;
    if (left <= 2) throw new ConflictError("too_few_finalists", "Finals need at least two finalists; add another before taking this one off.");
    tx.delete(finalists).where(and(eq(finalists.finalsId, row.id), eq(finalists.projectId, projectId))).run();
    return {
      result: { project: projectId, removed: true },
      audit: {
        action: "finals.finalist_remove",
        eventId: event.id,
        targetType: "finals",
        targetId: row.id,
        before: { project: projectId, ...(f.reason ? { addedReason: f.reason } : {}) },
        after: top.has(projectId) ? { reason: input.reason } : undefined,
      },
    };
  });
}

export function setFinalsPanel(actor: Actor | null, eventIdOrSlug: string, finalsId: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const row = requireRound(tx, event, finalsId);
    stillOpen(row);
    const input = parse(PanelInput, body ?? {});
    const wanted = [...new Set(input.judges)].sort();
    if (wanted.length < 2) throw new ValidationError("A panel needs at least two different judges.", { judges: ["at least two judges"] });
    const judges = new Set(tx.select({ id: userRoles.userId }).from(userRoles).where(and(eq(userRoles.eventId, event.id), eq(userRoles.role, "judge"))).all().map((r) => r.id));
    const before = tx.select({ id: finalsPanel.judgeUserId }).from(finalsPanel).where(eq(finalsPanel.finalsId, row.id)).all().map((r) => r.id).sort();
    // a panelist already on the panel may stay after being removed or left out (their scores stop counting); a judge
    // joining it must be one whose scores would count, or one judge could end up deciding the finals alone
    const joining = wanted.filter((j) => !before.includes(j));
    const strangers = joining.filter((j) => !judges.has(j));
    if (strangers.length) throw new ValidationError("Only this event's judges can sit on its panel.", { judges: strangers.map((j) => `${j} is not a judge of this event`) });
    const out = finalsLeftOut(tx, event.id);
    const leftOut = joining.filter((j) => out.get(j) === "left_out");
    if (leftOut.length) {
      throw new ConflictError("judge_left_out", `${leftOut.length === 1 ? "This judge is" : "These judges are"} left out of the ranking, so their finals scores would not count: restore ${leftOut.length === 1 ? "this judge" : "them"} first.`);
    }
    if (before.join(",") === wanted.join(",")) return { result: { panel: wanted, changed: false }, audit: null };
    // once a panelist has scored, a change can drop their scores from the finals order: it needs the organizer's reason,
    // which the published results show (JUDGING.md, "Finals")
    const scored = Boolean(tx.select({ id: finalsScores.id }).from(finalsScores).where(eq(finalsScores.finalsId, row.id)).get());
    if (scored && !input.reason) {
      throw new ValidationError("Say why the panel changes: finals scores are already in, and a panelist taken off stops counting.", { reason: ["reason_needed"] });
    }
    const reason = scored ? input.reason! : null;
    const at = new Date().toISOString();
    for (const j of before) if (!wanted.includes(j)) tx.delete(finalsPanel).where(and(eq(finalsPanel.finalsId, row.id), eq(finalsPanel.judgeUserId, j))).run();
    for (const j of wanted) if (!before.includes(j)) tx.insert(finalsPanel).values({ finalsId: row.id, eventId: event.id, judgeUserId: j, addedAt: at, addedBy: actor!.userId }).run();
    return {
      result: { panel: wanted, changed: true },
      audit: { action: "finals.panel", eventId: event.id, targetType: "finals", targetId: row.id, before: { panel: before }, after: { panel: wanted, ...(reason ? { reason } : {}) } },
    };
  });
}

export function closeFinals(actor: Actor | null, eventIdOrSlug: string, finalsId: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    notPublished(event);
    const row = requireRound(tx, event, finalsId);
    stillOpen(row);
    const input = parse(CloseFinalsInput, body ?? {});
    const round = rounds(tx, event.id).find((r) => r.row.id === row.id)!;
    if (round.panel.length < 2) throw new ConflictError("no_panel", "Name a panel of at least two judges before closing the finals.");
    // a panelist removed or left out after scoring no longer counts: fewer than two counted panelists would let one
    // judge decide the finals, so that needs the organizer's written reason, as closing early does
    if (round.counted.length < 2 && !input.reason) {
      throw new ConflictError(
        "too_few_counted",
        `Only ${round.counted.length === 1 ? "one panelist's" : "no panelist's"} finals scores count (the others were removed or left out of the ranking). To close with ${round.counted.length === 1 ? "one" : "none"}, say why.`,
      );
    }
    if (round.missing > 0 && !input.reason) {
      throw new ConflictError(
        "finals_incomplete",
        `${round.missing} ${round.missing === 1 ? "score is" : "scores are"} still missing (each counted panelist scores each finalist they are free to score). To close now, say why.`,
      );
    }
    const at = new Date().toISOString();
    const reason = round.missing > 0 || round.counted.length < 2 ? input.reason! : null;
    tx.update(finals).set({ closedAt: at, closedBy: actor!.userId, closeReason: reason }).where(eq(finals.id, row.id)).run();
    return {
      result: { id: row.id, closedAt: at, missing: round.missing },
      audit: {
        action: "finals.close",
        eventId: event.id,
        targetType: "finals",
        targetId: row.id,
        after: { missing: round.missing, ...(reason ? { reason } : {}), order: round.standings.map((s) => ({ project: s.projectId, score: s.score === null ? null : Math.round(s.score * 1000) / 1000, n: s.n })) },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The organizer's view
// ---------------------------------------------------------------------------

export type FinalsView = {
  id: string;
  track: { id: string; name: string } | null;
  suggested: number;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  missing: number;
  finalists: { projectId: string; title: string; trackName: string; place: number | null; inTopN: boolean; reason: string | null; score: number | null; se: number | null; n: number }[];
  /** each panelist: the finalists they scored, the finalists they may score (conflicts left out), their conflicts by finalist title, and whether their scores are out of the order */
  panel: { id: string; name: string; scored: number; toScore: number; conflicts: { title: string; why: FinalsConflict }[]; out: "removed" | "left_out" | null }[];
  panelChanges: { at: string; reason: string; added: number; removed: number }[];
  /** ranked projects of the round's track(s) that are not finalists, best first: what the organizer may add */
  candidates: { projectId: string; title: string; trackName: string; place: number | null; inTopN: boolean }[];
};

export type FinalsOverview = {
  event: { name: string; slug: string; resultsPublishedAt: string | null };
  judges: { id: string; name: string }[]; tracks: { id: string; name: string }[]; rounds: FinalsView[]; published: boolean };

export function getFinals(actor: Actor | null, eventIdOrSlug: string): FinalsOverview {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const judges = db
    .select({ id: users.id, name: users.name })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.eventId, event.id), eq(userRoles.role, "judge")))
    .all()
    .sort((a, b) => compareNames(a.name, b.name));
  const names = new Map(judges.map((j) => [j.id, j.name]));
  const trackRows = db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.position), asc(tracks.name)).all();
  const all = rounds(db, event.id);
  const places = all.length ? roundOnePlaces(db, event) : [];
  const byId = new Map(places.map((p) => [p.id, p]));
  const lines = all.length ? scoreLines(db, all.map((r) => r.row.id)) : [];
  const leftOut = all.length ? finalsLeftOut(db, event.id) : new Map<string, "removed" | "left_out">();
  // a judge removed from the event is no longer among the judges: their name comes from their account
  const panelIds = [...new Set(all.flatMap((r) => r.panel))].filter((id) => !names.has(id));
  if (panelIds.length) for (const u of db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, panelIds)).all()) names.set(u.id, u.name);
  return {
    event: { name: event.name, slug: event.slug, resultsPublishedAt: event.resultsPublishedAt },
    judges,
    tracks: trackRows,
    published: Boolean(event.resultsPublishedAt),
    rounds: all.map((r) => {
      const scope = places.filter((p) => r.row.trackId === null || p.trackId === r.row.trackId);
      const top = (id: string) => {
        const p = byId.get(id);
        return Boolean(p && p.place !== null && p.place <= r.row.suggested && (r.row.trackId === null || p.trackId === r.row.trackId));
      };
      const standing = new Map(r.standings.map((s) => [s.projectId, s]));
      const fin = new Set(r.finalists.map((f) => f.projectId));
      return {
        id: r.row.id,
        track: r.row.trackId ? (trackRows.find((t) => t.id === r.row.trackId) ?? null) : null,
        suggested: r.row.suggested,
        openedAt: r.row.openedAt,
        closedAt: r.row.closedAt,
        closeReason: r.row.closeReason,
        missing: r.missing,
        finalists: r.finalists
          .map((f) => {
            const p = byId.get(f.projectId);
            const s = standing.get(f.projectId);
            return { projectId: f.projectId, title: p?.title ?? f.projectId, trackName: p?.trackName ?? "", place: p?.place ?? null, inTopN: top(f.projectId), reason: f.reason, score: s?.score ?? null, se: s?.se ?? null, n: s?.n ?? 0 };
          })
          .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || (a.place ?? Infinity) - (b.place ?? Infinity) || a.title.localeCompare(b.title)),
        panel: r.panel
          .map((id) => {
            const conflicts = r.finalists.flatMap((f) => {
              const why = r.conflicts.get(`${id}|${f.projectId}`);
              return why ? [{ title: byId.get(f.projectId)?.title ?? f.projectId, why }] : [];
            });
            return {
              id,
              name: names.get(id) ?? id,
              scored: new Set(lines.filter((l) => l.finalsId === r.row.id && l.judgeUserId === id && fin.has(l.projectId) && !r.conflicts.has(`${id}|${l.projectId}`)).map((l) => l.projectId)).size,
              toScore: r.finalists.length - conflicts.length,
              conflicts,
              out: leftOut.get(id) ?? null,
            };
          })
          .sort((a, b) => compareNames(a.name, b.name)),
        panelChanges: panelChanges(db, r.row.id),
        candidates: scope
          .filter((p) => !fin.has(p.id))
          .sort((a, b) => a.trackName.localeCompare(b.trackName) || (a.place ?? Infinity) - (b.place ?? Infinity) || a.title.localeCompare(b.title))
          .map((p) => ({ projectId: p.id, title: p.title, trackName: p.trackName, place: p.place, inTopN: top(p.id) })),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// The panelist
// ---------------------------------------------------------------------------

function panelRounds(db: DbOrTx, eventId: string, judgeUserId: string): string[] {
  return db
    .select({ id: finalsPanel.finalsId })
    .from(finalsPanel)
    .where(and(eq(finalsPanel.eventId, eventId), eq(finalsPanel.judgeUserId, judgeUserId)))
    .all()
    .map((r) => r.id);
}

/** Whether the signed-in judge sits on a finals panel of the event: the judge console links to the finals page then. Their own membership only. */
export function onFinalsPanel(actor: Actor | null, eventIdOrSlug: string): boolean {
  if (!actor) return false;
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  return panelRounds(db, event.id, actor.userId).length > 0;
}

export type PanelFinalist = {
  projectId: string;
  title: string;
  teamName: string;
  trackName: string;
  summary: string;
  repoUrl: string | null;
  videoUrl: string | null;
  liveUrl: string | null;
  /** this panelist's own score, by criterion key; null until saved */
  mine: { values: Record<string, number>; total: number | null; savedAt: string } | null;
  /** why this panelist may not score this finalist (their own team's project, or one they recused from); null when free to */
  conflict: FinalsConflict | null;
};

export type PanelView = {
  event: { name: string; slug: string };
  judge: { id: string; name: string };
  criteria: Pick<Criterion, "key" | "label" | "prompt" | "weight" | "scaleMin" | "scaleMax" | "anchors">[];
  published: boolean;
  /** this panelist's scores are out of the finals order: removed from the judges or left out of the ranking; null when they count */
  out: "removed" | "left_out" | null;
  rounds: { id: string; trackName: string | null; closed: boolean; finalists: PanelFinalist[] }[];
};

/**
 * A panelist's finals: only the rounds they sit on, only those rounds' finalists, and only their own scores. The
 * judge id is the session's; `requestedJudgeId` (the API's ?judge=) must be that id or the answer is 403, as the
 * first round's peer route: there is no path on which one panelist's request returns another's scores.
 */
export function getPanelFinals(actor: Actor | null, eventIdOrSlug: string, requestedJudgeId: string | null = null): PanelView {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const onPanel = actor ? panelRounds(db, event.id, actor.userId).length > 0 : false;
  const me = guardRead(actor, "finals.read_own", { kind: "finals_scores", event: eventFacts(event), judgeUserId: requestedJudgeId ?? actor?.userId ?? "", onPanel });
  const mine = panelRounds(db, event.id, me.userId);
  const rows = db.select().from(finals).where(and(eq(finals.eventId, event.id), inArray(finals.id, mine))).orderBy(asc(finals.openedAt)).all();
  const fin = db.select().from(finalists).where(inArray(finalists.finalsId, mine)).all();
  const criteria = rubricOf(db, event.id);
  const ids = [...new Set(fin.map((f) => f.projectId))];
  const info = new Map(
    (ids.length
      ? db
          .select({
            id: projects.id,
            title: shownTitle(),
            teamName: teams.name,
            trackName: tracks.name,
            summary: projects.summary,
            repoUrl: projects.repoUrl,
            videoUrl: projects.videoUrl,
            liveUrl: projects.liveUrl,
          })
          .from(projects)
          .innerJoin(teams, eq(teams.id, projects.teamId))
          .innerJoin(tracks, eq(tracks.id, projects.trackId))
          .where(inArray(projects.id, ids))
          .all()
      : []
    ).map((p) => [p.id, p]),
  );
  // only this panelist's own rows are ever read
  const own = scoreLines(db, mine).filter((l) => l.judgeUserId === me.userId);
  const keyOf = new Map(criteria.map((c) => [c.id, c.key]));
  const trackNames = new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).all().map((t) => [t.id, t.name]));
  // only this panelist's own conflicts and standing are read
  const conflicts = finalsConflicts(db, event.id, me.userId);
  return {
    event: { name: event.name, slug: event.slug },
    judge: { id: me.userId, name: me.name },
    out: finalsLeftOut(db, event.id).get(me.userId) ?? null,
    criteria: criteria.map(({ key, label, prompt, weight, scaleMin, scaleMax, anchors }) => ({ key, label, prompt, weight, scaleMin, scaleMax, anchors })),
    published: Boolean(event.resultsPublishedAt),
    rounds: rows.map((r) => ({
      id: r.id,
      trackName: r.trackId ? (trackNames.get(r.trackId) ?? null) : null,
      closed: Boolean(r.closedAt),
      finalists: fin
        .filter((f) => f.finalsId === r.id && info.has(f.projectId))
        .map((f) => {
          const p = info.get(f.projectId)!;
          const s = own.find((l) => l.finalsId === r.id && l.projectId === f.projectId);
          return {
            projectId: p.id,
            title: p.title,
            teamName: p.teamName,
            trackName: p.trackName,
            summary: p.summary,
            repoUrl: p.repoUrl,
            videoUrl: p.videoUrl,
            liveUrl: p.liveUrl,
            mine: s ? { values: Object.fromEntries([...s.values].map(([cid, v]) => [keyOf.get(cid) ?? cid, v])), total: totalOf(criteria, s.values), savedAt: s.savedAt } : null,
            conflict: conflicts.get(`${me.userId}|${p.id}`) ?? null,
          };
        })
        .sort((a, b) => a.trackName.localeCompare(b.trackName) || a.title.localeCompare(b.title)),
    })),
  };
}

export type FinalsScoresView = {
  judge: { id: string; name: string };
  scores: { finals: string; projectId: string; title: string; values: Record<string, number>; total: number | null; savedAt: string }[];
};

/** A panelist's own finals scores only: the same gate and the same session id as getPanelFinals. */
export function getFinalsScores(actor: Actor | null, eventIdOrSlug: string, requestedJudgeId: string | null = null): FinalsScoresView {
  const view = getPanelFinals(actor, eventIdOrSlug, requestedJudgeId);
  return {
    judge: view.judge,
    scores: view.rounds.flatMap((r) =>
      r.finalists.flatMap((f) => (f.mine ? [{ finals: r.id, projectId: f.projectId, title: f.title, values: f.mine.values, total: f.mine.total, savedAt: f.mine.savedAt }] : [])),
    ),
  };
}

/** A panelist saves their score of one finalist: every criterion, a whole number on its scale. Saving again replaces it. */
export function saveFinalsScore(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  let input: z.infer<typeof FinalsScoreInput>;
  return mutate({
    actor,
    action: "finals.score",
    load: (tx: Tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      // no session: 401 before the body or the round is looked at
      if (!actor) return { kind: "finals_entry", event: eventFacts(event), onPanel: false, isFinalist: false, closed: false, conflict: null };
      input = parse(FinalsScoreInput, body ?? {});
      const row = requireRound(tx, event, input.finals);
      const onPanel = actor
        ? Boolean(tx.select({ id: finalsPanel.judgeUserId }).from(finalsPanel).where(and(eq(finalsPanel.finalsId, row.id), eq(finalsPanel.judgeUserId, actor.userId))).get())
        : false;
      const isFinalist = Boolean(tx.select({ id: finalists.projectId }).from(finalists).where(and(eq(finalists.finalsId, row.id), eq(finalists.projectId, input.project))).get());
      const conflict = finalsConflicts(tx, event.id, actor.userId, input.project).get(`${actor.userId}|${input.project}`) ?? null;
      return { kind: "finals_entry", event: eventFacts(event), onPanel, isFinalist, closed: Boolean(row.closedAt), conflict };
    },
    run: (tx) => {
      const criteria = rubricOf(tx, event.id);
      const errors: Record<string, string[]> = {};
      for (const c of criteria) {
        const v = input.values[c.key];
        if (v === undefined) errors[c.key] = ["score every criterion"];
        else if (v < c.scaleMin || v > c.scaleMax) errors[c.key] = [`between ${c.scaleMin} and ${c.scaleMax}`];
      }
      for (const k of Object.keys(input.values)) if (!criteria.some((c) => c.key === k)) errors[k] = ["not a criterion of this rubric"];
      if (Object.keys(errors).length) throw new ValidationError("Check the scores.", errors);
      const at = new Date().toISOString();
      const existing = tx
        .select({ id: finalsScores.id })
        .from(finalsScores)
        .where(and(eq(finalsScores.finalsId, input.finals), eq(finalsScores.projectId, input.project), eq(finalsScores.judgeUserId, actor!.userId)))
        .get();
      const before = existing ? scoreLines(tx, [input.finals]).find((l) => l.id === existing.id) : undefined;
      const id = existing?.id ?? newId("fsc");
      if (existing) {
        tx.update(finalsScores).set({ savedAt: at }).where(eq(finalsScores.id, id)).run();
        tx.delete(finalsScoreItems).where(eq(finalsScoreItems.finalsScoreId, id)).run();
      } else {
        tx.insert(finalsScores).values({ id, finalsId: input.finals, eventId: event.id, projectId: input.project, judgeUserId: actor!.userId, savedAt: at }).run();
      }
      for (const c of criteria) tx.insert(finalsScoreItems).values({ finalsScoreId: id, criterionId: c.id, value: input.values[c.key]! }).run();
      const values = Object.fromEntries(criteria.map((c) => [c.key, input.values[c.key]!]));
      const total = weightedTotal(criteria, criteria.map((c) => input.values[c.key]!));
      const keyOf = new Map(criteria.map((c) => [c.id, c.key]));
      return {
        result: { id, finals: input.finals, project: input.project, values, total, savedAt: at },
        audit: {
          action: "finals.score",
          eventId: event.id,
          targetType: "finals_score",
          targetId: id,
          before: before ? { values: Object.fromEntries([...before.values].map(([cid, v]) => [keyOf.get(cid) ?? cid, v])) } : undefined,
          after: { finals: input.finals, project: input.project, values, total: Math.round(total * 1000) / 1000 },
        },
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * finals.csv: one row per finals score, then (score_id empty) one row per finalist with its finals score, its ± and its
 * place. Once the results are published the place is the published place in its track (`published`, from exports.ts:
 * the one the results page, certificates and normalized.csv show, the tie-break included); before that, the place by
 * finals score within its track.
 */
export function finalsCsv(db: DbOrTx, event: EventRow, published: Map<string, number | null> | null = null): string {
  const all = rounds(db, event.id);
  const criteria = rubricOf(db, event.id);
  const titles = new Map(db.select({ id: projects.id, title: shownTitle(), track: tracks.name }).from(projects).innerJoin(tracks, eq(tracks.id, projects.trackId)).innerJoin(teams, eq(teams.id, projects.teamId)).where(eq(projects.eventId, event.id)).all().map((p) => [p.id, p]));
  const names = new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name]));
  const lines = scoreLines(db, all.map((r) => r.row.id));
  const header = ["finals_id", "finals_track", "closed_at", "close_reason", "project_id", "project_title", "track", "finalist_reason", "score_id", "judge_id", "judge", "on_panel", "saved_at", ...criteria.map((c) => c.key), "total", "finals_score", "finals_se", "finals_place"];
  const out: (string | number | null)[][] = [];
  for (const r of all) {
    const panel = new Set(r.panel);
    const scored = r.standings.filter((s) => s.score !== null);
    // before publishing: by finals score within each track (a round over every track holds several)
    const places = new Map<string, number | null>();
    for (const track of new Set(scored.map((x) => titles.get(x.projectId)?.track ?? ""))) {
      const mine = scored.filter((x) => (titles.get(x.projectId)?.track ?? "") === track);
      for (const [id, place] of competitionPlaceOf(new Map(mine.map((x) => [x.projectId, x.score!])))) places.set(id, place);
    }
    const scope = r.row.trackId ? (titles.get(r.finalists[0]?.projectId ?? "")?.track ?? "") : "";
    for (const f of r.finalists) {
      const p = titles.get(f.projectId);
      const s = r.standings.find((x) => x.projectId === f.projectId);
      for (const l of lines.filter((x) => x.finalsId === r.row.id && x.projectId === f.projectId)) {
        out.push([r.row.id, scope, r.row.closedAt, r.row.closeReason, f.projectId, p?.title ?? null, p?.track ?? null, f.reason, l.id, l.judgeUserId, names.get(l.judgeUserId) ?? null, panel.has(l.judgeUserId) ? "yes" : "no", l.savedAt, ...criteria.map((c) => l.values.get(c.id) ?? null), totalOf(criteria, l.values), null, null, null]);
      }
      out.push([r.row.id, scope, r.row.closedAt, r.row.closeReason, f.projectId, p?.title ?? null, p?.track ?? null, f.reason, null, null, null, null, null, ...criteria.map(() => null), null, s?.score ?? null, s?.se ?? null, (published ? published.get(f.projectId) : places.get(f.projectId)) ?? null]);
    }
  }
  return toCsv(header, out);
}

/**
 * fixtures.json's finals (the event file's history, import-history.ts restores them into a new event): each round with
 * its finalists, panel and scores, the values keyed by criterion key. A finalist, panelist or score whose project or
 * judge the file does not carry stays out, as their reviews do. Empty for an event with no finals.
 */
export function finalsHistory(db: DbOrTx, eventId: string, submitted: Set<string>, judgeIds: Set<string>) {
  const rows = db.select().from(finals).where(eq(finals.eventId, eventId)).orderBy(asc(finals.openedAt), asc(finals.id)).all();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const fin = db.select().from(finalists).where(inArray(finalists.finalsId, ids)).orderBy(asc(finalists.addedAt), asc(finalists.projectId)).all();
  const pan = db.select().from(finalsPanel).where(inArray(finalsPanel.finalsId, ids)).orderBy(asc(finalsPanel.judgeUserId)).all();
  const keyOf = new Map(rubricOf(db, eventId).map((c) => [c.id, c.key]));
  const lines = scoreLines(db, ids);
  return rows.map((r) => ({
    id: r.id,
    track: r.trackId,
    suggested: r.suggested,
    opened_at: r.openedAt,
    ...(r.closedAt ? { closed_at: r.closedAt } : {}),
    ...(r.closeReason ? { close_reason: r.closeReason } : {}),
    finalists: fin.filter((f) => f.finalsId === r.id && submitted.has(f.projectId)).map((f) => ({ project: f.projectId, added_at: f.addedAt, ...(f.reason ? { reason: f.reason } : {}) })),
    panel: pan.filter((x) => x.finalsId === r.id && judgeIds.has(x.judgeUserId)).map((x) => x.judgeUserId),
    scores: lines
      .filter((l) => l.finalsId === r.id && judgeIds.has(l.judgeUserId) && submitted.has(l.projectId))
      .map((l) => ({ id: l.id, judge: l.judgeUserId, project: l.projectId, saved_at: l.savedAt, values: Object.fromEntries([...l.values].map(([cid, v]) => [keyOf.get(cid) ?? cid, v])) })),
  }));
}

/** event.json's finals: the rows as stored, present only when the event has finals. */
export function finalsExport(db: DbOrTx, eventId: string) {
  const rows = db.select().from(finals).where(eq(finals.eventId, eventId)).all();
  if (!rows.length) return null;
  const ids = rows.map((r) => r.id);
  const scoreRows = db.select().from(finalsScores).where(inArray(finalsScores.finalsId, ids)).all();
  return {
    finals: rows,
    finalists: db.select().from(finalists).where(inArray(finalists.finalsId, ids)).all(),
    panel: db.select().from(finalsPanel).where(inArray(finalsPanel.finalsId, ids)).all(),
    scores: scoreRows,
    scoreItems: scoreRows.length ? db.select().from(finalsScoreItems).where(inArray(finalsScoreItems.finalsScoreId, scoreRows.map((s) => s.id))).all() : [],
  };
}
