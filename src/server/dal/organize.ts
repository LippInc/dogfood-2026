import "server-only";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor, Resource } from "../authz";
import { getDb, type Tx } from "../db/client";
import {
  assignments,
  customAnswers,
  customQuestions,
  events,
  judgeTracks,
  prizes,
  projects,
  rubricCriteria,
  scoreItems,
  scores,
  comparisons,
  tracks,
  userRoles,
  type WeightChange,
} from "../db/schema";
import { ConflictError, ValidationError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { BUILTIN_CRITERIA, DEFAULT_CRITERIA } from "../rubric-defaults";
import { newId, slugify } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { parse, utcTime, utcTimeOrEmpty } from "./parse";

// The organizer's side of an event: create it, then change its details, tracks,
// prizes, questions for teams and the rubric. Every change is one audited mutate().
// Times arrive from the form as "YYYY-MM-DDTHH:MM" and are read as UTC.

const optionalUtc = utcTimeOrEmpty.optional().transform((v) => (v ? v : null));

export const Details = z
  .object({
    name: z.string().trim().min(3, "at least 3 characters").max(80),
    description: z.string().trim().max(5_000).default(""),
    submissionsOpenAt: optionalUtc,
    submissionsCloseAt: utcTime,
    judgingCloseAt: optionalUtc,
    maxTeamSize: z.coerce.number().int().min(1).max(20).default(4),
  })
  .superRefine((d, ctx) => {
    if (d.submissionsOpenAt && Date.parse(d.submissionsOpenAt) >= Date.parse(d.submissionsCloseAt)) {
      ctx.addIssue({ code: "custom", path: ["submissionsCloseAt"], message: "must be after submissions open" });
    }
    if (d.judgingCloseAt && Date.parse(d.judgingCloseAt) <= Date.parse(d.submissionsCloseAt)) {
      ctx.addIssue({ code: "custom", path: ["judgingCloseAt"], message: "must be after submissions close" });
    }
  });

export const TrackRows = z
  .array(z.object({ id: z.string().optional(), name: z.string().trim().min(1, "a track needs a name").max(60) }))
  .min(1, "an event needs at least one track")
  .max(40);
export const PrizeRows = z
  .array(z.object({ id: z.string().optional(), name: z.string().trim().min(1, "a prize needs a name").max(80), description: z.string().trim().max(500).default("") }))
  .max(40);
export const QuestionRows = z
  .array(
    z.object({
      id: z.string().optional(),
      label: z.string().trim().min(3).max(200),
      help: z.string().trim().max(300).default(""),
      type: z.enum(["text", "longtext", "url"]).default("longtext"),
      required: z.coerce.boolean().default(false),
    }),
  )
  .max(20);
export const RubricRows = z
  .array(
    z.object({
      id: z.string().optional(),
      label: z.string().trim().min(2).max(60),
      prompt: z.string().trim().max(200).default(""),
      weight: z.coerce.number().positive("a weight must be above 0").max(100),
    }),
  )
  .min(1, "the rubric needs at least one criterion")
  .max(8);

/**
 * The rubric as sent: the rows and a reason, needed only for a weight change after the first
 * score, which the published results then show. A bare list of rows (the body before reasons
 * existed) is still taken as the rows with no reason.
 */
export const RubricBody = z.object({ criteria: RubricRows, reason: z.string().trim().max(500).optional() });
const RubricInput = z.union([RubricRows, RubricBody]);

export const NewEvent = z.object({
  details: Details,
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,59}$/, "lowercase letters, digits and dashes")
    .optional()
    .or(z.literal("")),
  tracks: TrackRows,
  prizes: PrizeRows.default([]),
});

/**
 * The name and dates arrive nested under `details`, so a refusal is keyed by the field's own name
 * (submissionsOpenAt), the name the form's input carries and an API caller can act on; keyed by the
 * envelope, "details: expected string" left six fields to guess from and marked none of them.
 */
function parseNewEvent(body: unknown): z.output<typeof NewEvent> {
  const parsed = NewEvent.safeParse(body);
  if (parsed.success) return parsed.data;
  const fields: Record<string, string[]> = {};
  for (const { path, message } of parsed.error.issues) {
    const [top, sub] = path;
    const key = top === "details" && typeof sub === "string" ? sub : top === undefined ? "request" : String(top);
    (fields[key] ??= []).push(message);
  }
  throw new ValidationError("Check the highlighted fields.", fields);
}

function uniqueNames(rows: { name: string }[], what: string) {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = r.name.toLowerCase();
    if (seen.has(k)) throw new ValidationError(`Two ${what} are called "${r.name}".`, { [what]: [`"${r.name}" appears twice`] });
    seen.add(k);
  }
}

// ---------------------------------------------------------------------------

export function createEvent(actor: Actor | null, body: unknown) {
  return mutate({
    actor,
    action: "event.create",
    load: () => ({ kind: "platform" }),
    run: (tx) => {
      const input = parseNewEvent(body);
      uniqueNames(input.tracks, "tracks");
      const slug = input.slug || slugify(input.details.name);
      if (tx.select({ id: events.id }).from(events).where(eq(events.slug, slug)).get()) {
        throw new ValidationError("That web address is taken.", { slug: [`/events/${slug} already exists`] });
      }
      const now = new Date().toISOString();
      const id = newId("evt");
      const d = input.details;
      tx.insert(events)
        .values({
          id,
          slug,
          name: d.name,
          description: d.description,
          submissionsOpenAt: d.submissionsOpenAt,
          submissionsCloseAt: d.submissionsCloseAt,
          judgingCloseAt: d.judgingCloseAt,
          settings: { maxTeamSize: d.maxTeamSize },
          createdAt: now,
        })
        .run();
      input.tracks.forEach((t, position) => tx.insert(tracks).values({ id: newId("trk"), eventId: id, name: t.name, position }).run());
      input.prizes.forEach((p, position) =>
        tx.insert(prizes).values({ id: newId("prz"), eventId: id, name: p.name, description: p.description, position }).run(),
      );
      DEFAULT_CRITERIA.forEach((key, position) =>
        tx
          .insert(rubricCriteria)
          .values({
            id: `crit_${id}_${key}`,
            eventId: id,
            key,
            label: key[0].toUpperCase() + key.slice(1),
            prompt: BUILTIN_CRITERIA[key].prompt,
            anchors: BUILTIN_CRITERIA[key].anchors,
            weight: 1,
            position,
          })
          .run(),
      );
      tx.insert(userRoles).values({ userId: actor!.userId, eventId: id, role: "organizer", createdAt: now }).run();
      return {
        result: { id, slug },
        audit: { eventId: id, targetType: "event", targetId: id, after: { name: d.name, slug, tracks: input.tracks.length } },
      };
    },
  });
}

/** Load an event for one of its organizers, recording a refusal like every read gate. */
function organizerResource(tx: Tx, idOrSlug: string, ref: { event?: EventRow }): Resource {
  ref.event = requireEvent(tx, idOrSlug);
  return { kind: "event", event: eventFacts(ref.event) };
}

const DATE_KEYS = ["submissionsOpenAt", "submissionsCloseAt", "judgingCloseAt"] as const;

/** Dates compare as instants: the form sends "…T18:00", the store may hold "…T18:00:00Z". */
function sameValue(key: string, a: unknown, b: unknown): boolean {
  if (!(DATE_KEYS as readonly string[]).includes(key)) return a === b;
  const t = (v: unknown) => (typeof v === "string" && v ? Date.parse(v) : null);
  return t(a) === t(b);
}

/** Published results are final: their scoring and the dates that framed it no longer change. */
function resultsFinal(e: EventRow, what: string) {
  if (e.resultsPublishedAt) throw new ConflictError("results_published", `Results are published, so ${what} final.`);
}

/**
 * Deadline gaming: once any judge has saved a review, or answered a pairwise question, the
 * submission deadline cannot move later (nor reopen), or teams could change projects judges
 * have already judged. Moving it earlier stays possible.
 */
function deadlineHolds(tx: Tx, e: EventRow, nextClose: unknown) {
  if (typeof nextClose !== "string" || Date.parse(nextClose) <= Date.parse(e.submissionsCloseAt)) return;
  const scored = tx
    .select({ id: scores.id })
    .from(scores)
    .innerJoin(assignments, eq(assignments.id, scores.assignmentId))
    .where(eq(assignments.eventId, e.id))
    .get();
  const compared = tx
    .select({ id: comparisons.id })
    .from(comparisons)
    .where(and(eq(comparisons.eventId, e.id), isNull(comparisons.voidedAt)))
    .get();
  if (scored || compared) {
    throw new ConflictError("judging_started", "Judges have started judging, so the submission deadline can no longer move later: teams could change projects judges have already judged.");
  }
}

export function updateEventDetails(actor: Actor | null, idOrSlug: string, body: unknown) {
  const ref: { event?: EventRow } = {};
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => organizerResource(tx, idOrSlug, ref),
    run: (tx) => {
      const e = ref.event!;
      const d = parse(Details, body);
      const next = {
        name: d.name,
        description: d.description,
        submissionsOpenAt: d.submissionsOpenAt,
        submissionsCloseAt: d.submissionsCloseAt,
        judgingCloseAt: d.judgingCloseAt,
      };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(next)) {
        const stored = e[k as keyof typeof next];
        if (sameValue(k, stored, v)) (next as Record<string, unknown>)[k] = stored; // keep the stored form of an unchanged date
        else {
          before[k] = stored;
          after[k] = v;
        }
      }
      if (DATE_KEYS.some((k) => k in after)) resultsFinal(e, "the event's dates are");
      if ("submissionsCloseAt" in after) deadlineHolds(tx, e, after.submissionsCloseAt);
      if ((e.settings.maxTeamSize ?? 4) !== d.maxTeamSize) {
        before.maxTeamSize = e.settings.maxTeamSize ?? 4;
        after.maxTeamSize = d.maxTeamSize;
      }
      if (Object.keys(after).length === 0) return { result: { id: e.id }, audit: null };
      tx.update(events)
        .set({ ...next, settings: { ...e.settings, maxTeamSize: d.maxTeamSize } })
        .where(eq(events.id, e.id))
        .run();
      return { result: { id: e.id }, audit: { action: "event.update", eventId: e.id, targetType: "event", targetId: e.id, before, after } };
    },
  });
}

export function saveTracks(actor: Actor | null, idOrSlug: string, body: unknown) {
  const ref: { event?: EventRow } = {};
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => organizerResource(tx, idOrSlug, ref),
    run: (tx) => {
      const e = ref.event!;
      const rows = parse(TrackRows, body);
      uniqueNames(rows, "tracks");
      const existing = tx.select().from(tracks).where(eq(tracks.eventId, e.id)).all();
      const keep = new Set(rows.map((r) => r.id).filter(Boolean) as string[]);
      const removed = existing.filter((t) => !keep.has(t.id));
      for (const t of removed) {
        const used =
          tx.select({ n: sql<number>`count(*)` }).from(projects).where(eq(projects.trackId, t.id)).get()!.n +
          tx.select({ n: sql<number>`count(*)` }).from(judgeTracks).where(eq(judgeTracks.trackId, t.id)).get()!.n;
        if (used > 0) throw new ConflictError("track_in_use", `"${t.name}" has projects or judges; rename it instead of removing it.`);
      }
      // Temporary names first, so swapping two names never trips the unique (event, name) index.
      for (const t of existing) tx.update(tracks).set({ name: `\u0000${t.id}` }).where(eq(tracks.id, t.id)).run();
      if (removed.length) tx.delete(tracks).where(inArray(tracks.id, removed.map((t) => t.id))).run();
      rows.forEach((r, position) => {
        if (r.id && existing.some((t) => t.id === r.id)) {
          tx.update(tracks).set({ name: r.name, position }).where(eq(tracks.id, r.id)).run();
        } else {
          tx.insert(tracks).values({ id: newId("trk"), eventId: e.id, name: r.name, position }).run();
        }
      });
      return {
        result: { count: rows.length },
        audit: {
          action: "event.tracks",
          eventId: e.id,
          targetType: "event",
          targetId: e.id,
          before: existing.map((t) => t.name),
          after: rows.map((r) => r.name),
        },
      };
    },
  });
}

export function savePrizes(actor: Actor | null, idOrSlug: string, body: unknown) {
  const ref: { event?: EventRow } = {};
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => organizerResource(tx, idOrSlug, ref),
    run: (tx) => {
      const e = ref.event!;
      const rows = parse(PrizeRows, body);
      const before = tx.select({ name: prizes.name }).from(prizes).where(eq(prizes.eventId, e.id)).all().map((p) => p.name);
      tx.delete(prizes).where(eq(prizes.eventId, e.id)).run();
      rows.forEach((p, position) =>
        tx.insert(prizes).values({ id: p.id || newId("prz"), eventId: e.id, name: p.name, description: p.description, position }).run(),
      );
      return {
        result: { count: rows.length },
        audit: { action: "event.prizes", eventId: e.id, targetType: "event", targetId: e.id, before, after: rows.map((p) => p.name) },
      };
    },
  });
}

export function saveQuestions(actor: Actor | null, idOrSlug: string, body: unknown) {
  const ref: { event?: EventRow } = {};
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => organizerResource(tx, idOrSlug, ref),
    run: (tx) => {
      const e = ref.event!;
      const rows = parse(QuestionRows, body);
      const existing = tx.select().from(customQuestions).where(eq(customQuestions.eventId, e.id)).all();
      const keep = rows.map((r) => r.id).filter(Boolean) as string[];
      const dropping = existing.filter((q) => !keep.includes(q.id));
      if (dropping.length) {
        const answered = tx
          .select({ n: sql<number>`count(*)` })
          .from(customAnswers)
          .where(inArray(customAnswers.questionId, dropping.map((q) => q.id)))
          .get()!.n;
        if (answered > 0) throw new ConflictError("question_answered", "A question teams have already answered cannot be removed; edit it instead.");
        tx.delete(customQuestions)
          .where(and(eq(customQuestions.eventId, e.id), keep.length ? notInArray(customQuestions.id, keep) : sql`1 = 1`))
          .run();
      }
      rows.forEach((q, position) => {
        const values = { label: q.label, help: q.help, type: q.type, required: q.required, position };
        if (q.id && existing.some((x) => x.id === q.id)) tx.update(customQuestions).set(values).where(eq(customQuestions.id, q.id)).run();
        else tx.insert(customQuestions).values({ id: newId("q"), eventId: e.id, ...values }).run();
      });
      return {
        result: { count: rows.length },
        audit: {
          action: "event.questions",
          eventId: e.id,
          targetType: "event",
          targetId: e.id,
          before: existing.map((q) => q.label),
          after: rows.map((q) => `${q.label}${q.required ? " (required)" : ""}`),
        },
      };
    },
  });
}

/**
 * Labels and prompts can change until the results are published (audited). The set of criteria
 * is fixed once any score exists: removing a criterion would leave reviews half-defined. A
 * weight can still change after the first score, to fix a mistake, but only with a written
 * reason: the change is audited and kept on the event, and the published results show it (the
 * weights before and after, when, and why), so nobody re-weights the ranking quietly.
 */
export function saveRubric(actor: Actor | null, idOrSlug: string, body: unknown) {
  const ref: { event?: EventRow } = {};
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => organizerResource(tx, idOrSlug, ref),
    run: (tx) => {
      const e = ref.event!;
      resultsFinal(e, "the rubric is");
      const input = parse(RubricInput, body);
      const rows = Array.isArray(input) ? input : input.criteria;
      const reason = Array.isArray(input) ? "" : (input.reason ?? "");
      uniqueNames(rows.map((r) => ({ name: r.label })), "criteria");
      const existing = tx.select().from(rubricCriteria).where(eq(rubricCriteria.eventId, e.id)).orderBy(asc(rubricCriteria.position)).all();
      const sameSet =
        rows.length === existing.length && rows.every((r) => r.id && existing.some((c) => c.id === r.id));
      const sameWeights = sameSet && rows.every((r) => Math.abs(existing.find((c) => c.id === r.id)!.weight - r.weight) < 1e-9);
      let reweighted: WeightChange | null = null;
      if (!sameSet || !sameWeights) {
        const scored = tx
          .select({ n: sql<number>`count(*)` })
          .from(scoreItems)
          .innerJoin(rubricCriteria, eq(rubricCriteria.id, scoreItems.criterionId))
          .where(eq(rubricCriteria.eventId, e.id))
          .get()!.n;
        if (scored > 0 && !sameSet)
          throw new ConflictError("rubric_in_use", "Judges have scored already: the set of criteria is fixed. Labels, prompts and, with a reason, weights can change.");
        if (scored > 0) {
          if (reason.length < 3)
            throw new ValidationError("Judges have scored already, so a weight change needs a reason: the published results will show it.", {
              reason: ["say why the weights change, in a few words"],
            });
          reweighted = {
            at: new Date().toISOString(),
            reason,
            before: existing.map((c) => ({ id: c.id, label: c.label, weight: c.weight })),
            after: rows.map((r) => ({ id: r.id!, label: r.label, weight: r.weight })),
          };
        }
      }
      if (!sameSet) {
        const keep = rows.map((r) => r.id).filter(Boolean) as string[];
        tx.delete(rubricCriteria)
          .where(and(eq(rubricCriteria.eventId, e.id), keep.length ? notInArray(rubricCriteria.id, keep) : sql`1 = 1`))
          .run();
      }
      rows.forEach((r, position) => {
        if (r.id && existing.some((c) => c.id === r.id)) {
          tx.update(rubricCriteria).set({ label: r.label, prompt: r.prompt, weight: r.weight, position }).where(eq(rubricCriteria.id, r.id)).run();
        } else {
          const key = slugify(r.label).replace(/-/g, "_") || `criterion_${position + 1}`;
          tx.insert(rubricCriteria).values({ id: `crit_${e.id}_${key}_${newId("c", 4).slice(2)}`, eventId: e.id, key, label: r.label, prompt: r.prompt, weight: r.weight, position }).run();
        }
      });
      if (reweighted) {
        tx.update(events)
          .set({ settings: { ...e.settings, weightChanges: [...(e.settings.weightChanges ?? []), reweighted] } })
          .where(eq(events.id, e.id))
          .run();
      }
      return {
        result: { count: rows.length, reweighted: reweighted !== null },
        audit: reweighted
          ? { action: "event.rubric_reweighted", eventId: e.id, targetType: "event", targetId: e.id, before: reweighted.before, after: { weights: reweighted.after, reason } }
          : {
              action: "event.rubric",
              eventId: e.id,
              targetType: "event",
              targetId: e.id,
              before: existing.map((c) => ({ label: c.label, weight: c.weight })),
              after: rows.map((r) => ({ label: r.label, weight: r.weight })),
            },
      };
    },
  });
}

// ---------------------------------------------------------------------------

export type OrganizerEvent = {
  event: EventRow;
  tracks: { id: string; name: string; projects: number }[];
  prizes: { id: string; name: string; description: string }[];
  questions: { id: string; label: string; help: string; type: "text" | "longtext" | "url"; required: boolean; answers: number }[];
  rubric: { id: string; label: string; prompt: string; weight: number }[];
  scored: boolean;
};

/** Everything the organizer's settings need; refused (and audited) for anyone else. */
export function getOrganizerEvent(actor: Actor | null, idOrSlug: string): OrganizerEvent {
  const db = getDb();
  const event = requireEvent(db, idOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const count = sql<number>`(select count(*) from ${projects} p where p.track_id = ${tracks.id})`;
  const answers = sql<number>`(select count(*) from ${customAnswers} a where a.question_id = ${customQuestions.id})`;
  return {
    event,
    tracks: db.select({ id: tracks.id, name: tracks.name, projects: count }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.position)).all(),
    prizes: db.select({ id: prizes.id, name: prizes.name, description: prizes.description }).from(prizes).where(eq(prizes.eventId, event.id)).orderBy(asc(prizes.position)).all(),
    questions: db
      .select({ id: customQuestions.id, label: customQuestions.label, help: customQuestions.help, type: customQuestions.type, required: customQuestions.required, answers })
      .from(customQuestions)
      .where(eq(customQuestions.eventId, event.id))
      .orderBy(asc(customQuestions.position))
      .all(),
    rubric: db
      .select({ id: rubricCriteria.id, label: rubricCriteria.label, prompt: rubricCriteria.prompt, weight: rubricCriteria.weight })
      .from(rubricCriteria)
      .where(eq(rubricCriteria.eventId, event.id))
      .orderBy(asc(rubricCriteria.position))
      .all(),
    scored:
      db
        .select({ n: sql<number>`count(*)` })
        .from(scoreItems)
        .innerJoin(rubricCriteria, eq(rubricCriteria.id, scoreItems.criterionId))
        .where(eq(rubricCriteria.eventId, event.id))
        .get()!.n > 0,
  };
}

/** Events this person runs: the ones they organize, and every event for an administrator (who may also create one). */
export function organizedEvents(actor: Actor | null): { canCreate: boolean; events: { id: string; slug: string; name: string; submissionsCloseAt: string }[] } {
  if (!actor) return { canCreate: false, events: [] };
  const ids = actor.roles.filter((r) => r.role === "organizer").map((r) => r.eventId);
  const columns = { id: events.id, slug: events.slug, name: events.name, submissionsCloseAt: events.submissionsCloseAt };
  const list = actor.isAdmin
    ? getDb().select(columns).from(events).orderBy(asc(events.createdAt)).all()
    : ids.length
      ? getDb().select(columns).from(events).where(inArray(events.id, ids)).orderBy(asc(events.createdAt)).all()
      : [];
  return { canCreate: actor.isAdmin, events: list };
}
