import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { events, prizes, projects, teams, tracks, type EventSettings, type PrizeAward } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { guardRead } from "../mutate";
import { nowIso } from "../util";
import { eventFacts, organizerMutation, requireEvent, type EventRow } from "./events";
import { parse } from "./parse";
import { shownTitle } from "./project-fields";

// Prizes given to projects (JUDGING.md, "Prizes"). The event's prizes (a name and a description, organize.ts)
// are what can be won; an award gives one prize to one project, or to several jointly, with an optional note.
// Awards live in the event's settings (settings.prizeAwards), are decided before publishing, each change one
// audited action, and are final with the results: the app answers 409 and the database refuses the write
// (triggers.ts, events_prize_awards_final and prizes_final_*). A prize with no award stays unawarded, which
// publishing allows. An event that awards nothing keeps every page, export and record exactly as before.

/** A winning project as the pages show it. */
export type PrizeWinner = { projectId: string; title: string; teamName: string; trackName: string | null };

/** One of the event's prizes and who won it: no winners is an unawarded prize. */
export type PrizeStanding = {
  prizeId: string;
  name: string;
  description: string;
  winners: PrizeWinner[];
  note: string;
  /** when the award was last set; null while the prize is unawarded */
  at: string | null;
};

/** The projects that can win a prize: the event's submitted ones, a merged duplicate's copy excepted. */
function eligible(db: DbOrTx, eventId: string): Map<string, PrizeWinner> {
  const rows = db
    .select({ projectId: projects.id, title: shownTitle(), teamName: teams.name, trackName: tracks.name })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .leftJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .all();
  return new Map(rows.map((r) => [r.projectId, r]));
}

/**
 * Every prize of the event, in its order, with its winners. An award that names a prize removed since, or a
 * project merged into its other copy since it was given, counts only for what still stands:
 * a prize whose every winner went is unawarded again (the Overview says so before publishing).
 */
export function prizeStandings(db: DbOrTx, event: EventRow): PrizeStanding[] {
  const list = db
    .select({ id: prizes.id, name: prizes.name, description: prizes.description })
    .from(prizes)
    .where(eq(prizes.eventId, event.id))
    .orderBy(asc(prizes.position))
    .all();
  if (!list.length) return [];
  const given = new Map((event.settings.prizeAwards ?? []).map((a) => [a.prizeId, a]));
  const can = given.size ? eligible(db, event.id) : new Map<string, PrizeWinner>();
  return list.map((p) => {
    const a = given.get(p.id);
    const winners = (a?.projectIds ?? []).flatMap((id) => (can.has(id) ? [can.get(id)!] : []));
    return { prizeId: p.id, name: p.name, description: p.description, winners, note: winners.length ? (a?.note ?? "") : "", at: winners.length ? (a?.at ?? null) : null };
  });
}

/** The published prizes, each with its winners; [] until the results are published or when no prize was awarded. Public. */
export function publishedPrizes(eventIdOrSlug: string): PrizeStanding[] {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  if (!event.resultsPublishedAt) return [];
  const all = prizeStandings(db, event);
  return all.some((p) => p.winners.length) ? all : [];
}

/** The prizes a project won in published results, by name, in the event's prize order (for its page and its certificate). */
export function prizesWonBy(eventIdOrSlug: string, projectId: string): { name: string; joint: boolean }[] {
  return publishedPrizes(eventIdOrSlug).flatMap((p) => (p.winners.some((w) => w.projectId === projectId) ? [{ name: p.name, joint: p.winners.length > 1 }] : []));
}

export type PrizeAwards = { published: boolean; prizes: PrizeStanding[] };

/**
 * GET the awards. Once the results are published they are public, as the results are. Before that they are the
 * organizers' draft: no session is 401, anyone else 403 (logged).
 */
export function getPrizeAwards(actor: Actor | null, eventIdOrSlug: string): PrizeAwards {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  if (!event.resultsPublishedAt) guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return { published: Boolean(event.resultsPublishedAt), prizes: prizeStandings(db, event) };
}

export const AwardInput = z.object({
  projectIds: z
    .array(z.string().trim().min(1))
    .max(20, "at most 20 winners for one prize")
    .default([])
    .describe("the winning projects' ids: one, several for a joint award, or none to leave the prize unawarded"),
  note: z.string().trim().max(300, "keep the note under 300 characters").default("").describe("optional: why, or what the winners share (shown with the prize)"),
});

/** Settings with the awards replaced; the key goes when no prize is awarded, so the settings read as before any award. */
export function withAwards(settings: EventSettings, awards: PrizeAward[]): EventSettings {
  const { prizeAwards: _old, ...rest } = settings;
  return awards.length ? { ...rest, prizeAwards: awards } : rest;
}

/**
 * Give a prize to one project or several (joint), or take it back with no projects. One audited action; refused
 * with 409 once the results are published (the database refuses it too). Projects are the event's submitted ones,
 * a merged duplicate's copy excepted; anything else is a 422 on projectIds.
 */
export function awardPrize(actor: Actor | null, eventIdOrSlug: string, prizeId: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    const prize = tx
      .select({ id: prizes.id, name: prizes.name })
      .from(prizes)
      .where(and(eq(prizes.id, prizeId), eq(prizes.eventId, event.id)))
      .get();
    if (!prize) throw new NotFoundError("Prize");
    if (event.resultsPublishedAt) {
      throw new ConflictError("results_published", "Results are published, so the prizes and who won them are final.");
    }
    const input = parse(AwardInput, body ?? {});
    if (new Set(input.projectIds).size !== input.projectIds.length) {
      throw new ValidationError("Check the winners.", { projectIds: ["a project is named twice"] });
    }
    const can = eligible(tx, event.id);
    const unknown = input.projectIds.filter((id) => !can.has(id));
    if (unknown.length) {
      throw new ValidationError("Check the winners.", {
        projectIds: [`not a submitted project of this event (or merged into another copy): ${unknown.join(", ")}`],
      });
    }
    const current = (event.settings.prizeAwards ?? []).find((a) => a.prizeId === prize.id) ?? null;
    const note = input.projectIds.length ? input.note : "";
    const same = current ? current.note === note && current.projectIds.join(" ") === input.projectIds.join(" ") : !input.projectIds.length;
    const view = (ids: string[], n: string) => ({ prize: prize.name, projects: ids.map((id) => ({ id, title: can.get(id)?.title ?? id })), ...(n ? { note: n } : {}) });
    if (same) return { result: { prizeId: prize.id, projectIds: input.projectIds, note, changed: false }, audit: null };
    const others = (event.settings.prizeAwards ?? []).filter((a) => a.prizeId !== prize.id);
    const next = input.projectIds.length ? [...others, { prizeId: prize.id, projectIds: input.projectIds, note, at: nowIso() }] : others;
    tx.update(events).set({ settings: withAwards(event.settings, next) }).where(eq(events.id, event.id)).run();
    return {
      result: { prizeId: prize.id, projectIds: input.projectIds, note, changed: true },
      audit: {
        action: "prize.award",
        eventId: event.id,
        targetType: "prize",
        targetId: prize.id,
        before: current ? view(current.projectIds, current.note) : { prize: prize.name, projects: [] },
        after: view(input.projectIds, note),
      },
    };
  });
}
