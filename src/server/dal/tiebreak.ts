import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import type { DbOrTx } from "../db/client";
import { events, rubricCriteria, scoreItems, type EventSettings, type TieBreakChange } from "../db/schema";
import { ConflictError, ValidationError } from "../errors";
import { breakTies, criterionMeans, tieGroups, type TieBreakGroup } from "../judging/tiebreak";
import { organizerMutation, type EventRow } from "./events";
import { finishedReviews, rubricOf } from "./judging";
import type { Normalized } from "./normalization";
import { judgingModeOf } from "./pairwise";
import { parse } from "./parse";
import { competitionPlaces, tieDecided } from "@/lib/places";

// The event's tie-break rule (JUDGING.md, "Breaking exact ties"): which rubric criterion orders projects whose
// scores are exactly tied within a track, or none (joint places, the default). Set by an organizer before the
// results are published, audited, and frozen with the rest of the settings at publishing. Scores mode only:
// pairwise judging has no criteria.

export const TieBreakInput = z.object({
  criterionId: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .describe("the id of one of the event's rubric criteria, or null to keep joint places (the default)"),
  reason: z
    .string()
    .trim()
    .max(500)
    .default("")
    .describe("needed once any judge has scored (422 without it): kept with the change and shown on the published results"),
});

export type TieBreakCriterion = { id: string; label: string };

/** The criterion that breaks exact ties in this event now, or null: none set, or the event judges pairwise. */
export function tieBreakCriterion(db: DbOrTx, event: EventRow): TieBreakCriterion | null {
  const id = event.settings.tieBreak?.criterionId;
  if (!id || judgingModeOf(event) === "pairwise") return null;
  const c = rubricOf(db, event.id).find((x) => x.id === id);
  return c ? { id: c.id, label: c.label } : null;
}

/** Whether any judge has scored in the event: from then on a tie-break change is kept and shown on the published results. */
export function anyScore(tx: DbOrTx, eventId: string): boolean {
  return (
    tx
      .select({ n: sql<number>`count(*)` })
      .from(scoreItems)
      .innerJoin(rubricCriteria, eq(rubricCriteria.id, scoreItems.criterionId))
      .where(eq(rubricCriteria.eventId, eventId))
      .get()!.n > 0
  );
}

/**
 * Set or clear the tie-break criterion. Organizers only (401 without a session, 403 for anyone else, audited), until
 * the results are published (409). Refused in pairwise mode (409): it has no criteria. Once any judge has scored, a
 * change needs a written reason: it is kept on the event and the published results show it, as a weight change is.
 */
export function setTieBreak(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    const input = parse(TieBreakInput, body);
    if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so how ties were broken is final.");
    if (judgingModeOf(event) === "pairwise" && input.criterionId !== null) {
      throw new ConflictError("pairwise_mode", "This event judges pairwise, which has no rubric criteria to break a tie by: tied projects keep a joint place.");
    }
    const criteria = rubricOf(tx, event.id);
    const pick = (id: string | null | undefined): TieBreakCriterion | null => {
      const c = id ? criteria.find((x) => x.id === id) : undefined;
      return c ? { id: c.id, label: c.label } : null;
    };
    const after = pick(input.criterionId);
    if (input.criterionId !== null && !after) {
      throw new ValidationError("Check the highlighted fields.", { criterionId: ["choose one of this event's rubric criteria, or keep joint places"] });
    }
    const before = pick(event.settings.tieBreak?.criterionId);
    if ((before?.id ?? null) === (after?.id ?? null)) return { result: { criterion: after, changed: false }, audit: null };
    const scored = anyScore(tx, event.id);
    if (scored && input.reason.length < 3) {
      throw new ValidationError("Judges have scored already, so a tie-break change needs a reason: the published results will show it.", {
        reason: ["say why the tie-break changes, in a few words"],
      });
    }
    const { tieBreak: _old, ...rest } = event.settings;
    const settings: EventSettings = { ...rest, ...(after ? { tieBreak: { criterionId: after.id } } : {}) };
    if (scored) {
      const change: TieBreakChange = { at: new Date().toISOString(), reason: input.reason, before, after };
      settings.tieBreakChanges = [...(event.settings.tieBreakChanges ?? []), change];
    }
    tx.update(events).set({ settings }).where(eq(events.id, event.id)).run();
    return {
      result: { criterion: after, changed: true },
      audit: {
        action: "event.tie_break",
        eventId: event.id,
        targetType: "event",
        targetId: event.id,
        before: { criterion: before },
        after: { criterion: after, ...(input.reason ? { reason: input.reason } : {}), ...(scored ? { afterScoring: true } : {}) },
      },
    };
  });
}

/**
 * Each counted project's plain mean on the criterion: the engine applies its leniency correction to the weighted total
 * only, never to a single criterion, so the tie-break reads the criterion as the judges gave it, over exactly the
 * reviews the engine counts (finished, not recused or conflicted, judges not left out; a merged copy's reviews count
 * for the copy kept, one figure per judge).
 */
export function criterionFigures(db: DbOrTx, event: EventRow, n: Normalized, criterionId: string): Map<string, number> {
  const criteria = rubricOf(db, event.id);
  const at = criteria.findIndex((c) => c.id === criterionId);
  if (at < 0) return new Map();
  const canonical = new Map(n.projects.map((p) => [p.id, p.duplicateOf ?? p.id]));
  const left = new Set(n.excluded);
  const obs = finishedReviews(db, event.id, criteria)
    .filter((r) => canonical.has(r.projectId) && !left.has(r.judgeId))
    .map((r) => ({ judgeId: r.judgeId, projectId: canonical.get(r.projectId)!, value: r.values[at]! }));
  return criterionMeans(obs);
}

export type TieBreakView = {
  criterion: TieBreakCriterion;
  /** every exact score tie within a track, in track order then best first, and how the criterion ordered it */
  groups: (Omit<TieBreakGroup, "projects"> & { trackName: string; projects: { id: string; title: string; figure: number | null; place: number; broken: boolean; decided: boolean }[] })[];
  /** every ranked project's competition place in its track after the tie-break */
  places: Record<string, number>;
};

/** The tie-break over a normalization run's tracks: what the organizer's Results tab shows and publishing stores. Null with no tie-break. */
export function tieBreakOf(db: DbOrTx, event: EventRow, n: Normalized): TieBreakView | null {
  const criterion = tieBreakCriterion(db, event);
  if (!criterion) return null;
  const figures = criterionFigures(db, event, n, criterion.id);
  const canonical = n.projects.filter((p) => !p.duplicateOf && p.score !== null);
  const title = new Map(canonical.map((p) => [p.id, p.title]));
  const byTrack = new Map<string, { name: string; rows: { projectId: string; score: number | null }[] }>();
  for (const p of canonical) {
    const t = byTrack.get(p.trackId) ?? { name: p.trackName, rows: [] };
    t.rows.push({ projectId: p.id, score: p.score });
    byTrack.set(p.trackId, t);
  }
  const groups: TieBreakView["groups"] = [];
  const allPlaces: Record<string, number> = {};
  for (const [trackId, t] of byTrack) {
    const sorted = [...t.rows].sort((a, b) => b.score! - a.score! || a.projectId.localeCompare(b.projectId));
    const broken = breakTies(sorted, figures);
    const placed = competitionPlaces(broken);
    const places = new Map(broken.map((r, i) => [r.projectId, placed[i]!.place!]));
    const split = new Map(broken.map((r) => [r.projectId, r.tieBroken]));
    // whether the criterion decided the place (tieDecided), not only moved it: a place it left joint is not decided
    const decided = new Map(broken.map((r, i) => [r.projectId, tieDecided(r, placed[i]!)]));
    for (const [id, place] of places) allPlaces[id] = place;
    for (const g of tieGroups(trackId, broken)) {
      groups.push({ ...g, trackName: t.name, projects: g.projects.map((p) => ({ ...p, title: title.get(p.id) ?? p.id, place: places.get(p.id)!, broken: split.get(p.id)!, decided: decided.get(p.id)! })) });
    }
  }
  return { criterion, groups, places: allPlaces };
}
