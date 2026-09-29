import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { events, tracks, type CloseCallChoice } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { closeCall, CALL_LINE, DRAWS, type CloseCall } from "../judging/decision";
import { guardRead } from "../mutate";
import { eventFacts, organizerMutation, requireEvent, type EventRow } from "./events";
import { computeNormalization, type Normalized } from "./normalization";
import { judgingModeOf } from "./pairwise";
import { parse } from "./parse";

// Close calls (JUDGING.md, "Close calls and the judges' decision"): per track, each ranked
// project's chance of really being first, read from the score engine's own ± (judging/decision.ts),
// and the organizer's choice where the ranking's top is too close to call: keep the ranking's
// winner, or record the judges' decision naming another of the close projects, with a reason.
// A choice is stored in the event's settings, so publishing freezes it; publishing also stores
// the decisions it applies with the run, and the published results read them from there.

/** The signal check's line, as the Results page and the public evidence read it: above it the scores cannot tell the projects apart. */
export const SIGNAL_LINE = 0.05;

export type TrackCloseCall = {
  trackId: string;
  trackName: string;
  /** every ranked project of the track, highest chance of being first first */
  projects: { id: string; title: string; score: number; se: number; p: number }[];
  /** the ranking's first place (more than one project only on an exact tie) */
  top: string[];
  /** the scores name the winner: the ranking's top is first in at least 95 % of the draws */
  callable: boolean;
  /** the close projects: the fewest, highest chance first, that are first in 95 % of the draws together */
  close: string[];
  /** the signal check found real differences between the projects (share at or below SIGNAL_LINE) */
  signal: boolean;
  /** too close to call on an event whose scores carry a signal: a decision to settle before publishing */
  required: boolean;
  choice: CloseCallChoice | null;
  /** why the stored choice no longer fits the scores; null when it fits or there is none */
  stale: string | null;
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Null when the stored choice still fits the track's close call; otherwise why it does not. */
function staleness(choice: CloseCallChoice, cc: CloseCall | null): string | null {
  if (!cc) return "the track no longer has two ranked projects";
  if (choice.mode === "keep") return sameSet(choice.top, cc.top) ? null : "the ranking's first place changed since the choice was made";
  if (cc.callable) return "the scores now name the winner clearly, so the judges' decision no longer applies";
  if (!choice.winnerId || !cc.close.includes(choice.winnerId)) return "the project the judges named is no longer among the close projects";
  return null;
}

/**
 * Every track's close call on the event as it stands, in track order. Empty in pairwise mode,
 * which has no ± of this kind. `now` is the normalization in hand; without its signal check,
 * the check is run once here (memoized with the run).
 */
export function closeCallsOf(db: DbOrTx, event: EventRow, now?: Normalized): TrackCloseCall[] {
  if (judgingModeOf(event) === "pairwise") return [];
  const n = now ?? computeNormalization(db, event);
  const choices = event.settings.closeCalls ?? [];
  const order = db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(eq(tracks.eventId, event.id))
    .orderBy(tracks.position, tracks.id)
    .all();
  const checked = order.flatMap((t) => {
    const rows = n.projects.filter((p) => p.trackId === t.id && !p.duplicateOf && p.score !== null);
    const cc = closeCall(rows.map((p) => ({ id: p.id, score: p.score!, se: p.se })));
    const choice = choices.find((c) => c.trackId === t.id) ?? null;
    return cc || choice ? [{ t, rows, cc, choice }] : [];
  });
  // the signal check (2,000 shuffles) runs only when some track is too close to call; memoized with the run
  const check = n.signal ?? (checked.some((c) => c.cc && !c.cc.callable) ? computeNormalization(db, event, { signal: true }).signal : null);
  const signal = check !== null && check.share <= SIGNAL_LINE;
  const out: TrackCloseCall[] = [];
  for (const { t, rows, cc, choice } of checked) {
    const byId = new Map(rows.map((p) => [p.id, p]));
    out.push({
      trackId: t.id,
      trackName: t.name,
      projects: (cc?.chances ?? []).map((c) => {
        const p = byId.get(c.id)!;
        return { id: c.id, title: p.title, score: p.score!, se: p.se!, p: c.p };
      }),
      top: cc?.top ?? [],
      callable: cc?.callable ?? true,
      close: cc?.close ?? [],
      signal,
      required: Boolean(cc && !cc.callable && signal),
      choice,
      stale: choice ? staleness(choice, cc) : null,
    });
  }
  return out;
}

/** A track's close call settles when its stored choice fits the scores. */
export const settled = (c: TrackCloseCall) => c.choice !== null && c.stale === null;

/**
 * The judges' decisions publishing applies: a judges' choice that still fits its track.
 * Stored with the published run, and only when there is one, so a run without any is
 * byte-for-byte what it was before close calls existed.
 */
export type AppliedDecision = {
  trackId: string;
  winnerId: string;
  reason: string;
  at: string;
  /** the ranking's first place by score */
  top: string[];
  /** the close projects' chances of being first, highest first */
  close: { id: string; p: number }[];
};

export function appliedDecisions(calls: TrackCloseCall[]): AppliedDecision[] {
  return calls
    .filter((c) => c.choice?.mode === "judges" && c.stale === null)
    .map((c) => ({
      trackId: c.trackId,
      winnerId: c.choice!.winnerId!,
      reason: c.choice!.reason ?? "",
      at: c.choice!.at,
      top: c.top,
      close: c.projects.filter((p) => c.close.includes(p.id)).map((p) => ({ id: p.id, p: p.p })),
    }));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function getCloseCalls(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const n = judgingModeOf(event) === "pairwise" ? null : computeNormalization(db, event, { signal: true });
  return {
    rule: { line: CALL_LINE, draws: DRAWS, signalLine: SIGNAL_LINE },
    mode: judgingModeOf(event),
    signal: n?.signal ? { share: n.signal.share, trials: n.signal.trials } : null,
    tracks: n ? closeCallsOf(db, event, n).map((c) => ({ ...c, settled: settled(c) })) : [],
  };
}

// ---------------------------------------------------------------------------
// Audited actions
// ---------------------------------------------------------------------------

const Reason = z.string().trim().min(3, "say why, in a few words").max(500);
export const CloseCallInput = z.union([
  z.object({ mode: z.literal("keep") }).describe("keep the ranking's winner"),
  z
    .object({
      mode: z.literal("judges"),
      winnerId: z.string().min(1).describe("the project the judges name first: one of the track's close projects"),
      reason: Reason.describe("why the judges chose it, shown on the public results"),
    })
    .describe("the judges' decision"),
]);

function trackOf(db: DbOrTx, event: EventRow, trackId: string) {
  const t = db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(and(eq(tracks.id, trackId), eq(tracks.eventId, event.id))).get();
  if (!t) throw new NotFoundError("Track");
  return t;
}

function openForChoices(event: EventRow) {
  if (event.resultsPublishedAt) throw new ConflictError("results_published", "Results are published, so the close calls are final.");
  if (judgingModeOf(event) === "pairwise") {
    throw new ConflictError("pairwise_mode", "Close calls are read from the score engine's ±; this event is judged by comparing projects, so it has none.");
  }
}

/**
 * Settle one track's close call: keep the ranking's winner (one click), or record the judges'
 * decision naming another of the close projects, with a required reason. Replaces an earlier
 * choice for the track. Only a track whose top is too close to call takes one.
 */
export function settleCloseCall(actor: Actor | null, eventIdOrSlug: string, trackId: string, body: unknown) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    openForChoices(event);
    const t = trackOf(tx, event, trackId);
    const input = parse(CloseCallInput, body);
    const call = closeCallsOf(tx, event).find((c) => c.trackId === t.id);
    if (!call || call.callable || !call.projects.length) {
      throw new ConflictError("not_a_close_call", `The scores name ${t.name}'s winner clearly (first in at least 95 % of the draws), so there is no close call to settle.`);
    }
    if (input.mode === "judges") {
      if (!call.close.includes(input.winnerId)) {
        const names = call.projects.filter((p) => call.close.includes(p.id)).map((p) => p.id);
        throw new ValidationError("Check the winner.", { winnerId: [`not one of the close projects of ${t.name}: ${names.join(", ")}`] });
      }
      if (call.top.length === 1 && call.top[0] === input.winnerId) {
        throw new ValidationError("Check the winner.", { winnerId: ["that is the ranking's winner already: keep the ranking instead"] });
      }
    }
    const at = new Date().toISOString();
    const choice: CloseCallChoice =
      input.mode === "keep"
        ? { trackId: t.id, mode: "keep", top: call.top, at }
        : { trackId: t.id, mode: "judges", top: call.top, winnerId: input.winnerId, reason: input.reason, at };
    const before = (event.settings.closeCalls ?? []).find((c) => c.trackId === t.id) ?? null;
    const closeCalls = [...(event.settings.closeCalls ?? []).filter((c) => c.trackId !== t.id), choice].sort((a, b) => (a.trackId < b.trackId ? -1 : 1));
    tx.update(events).set({ settings: { ...event.settings, closeCalls } }).where(eq(events.id, event.id)).run();
    const chances = call.projects.filter((p) => call.close.includes(p.id)).map((p) => ({ id: p.id, p: p.p }));
    return {
      result: { trackId: t.id, choice },
      audit: {
        action: "results.close_call",
        eventId: event.id,
        targetType: "track",
        targetId: t.id,
        before: before ? { ...before } : null,
        after: { ...choice, track: t.name, required: call.required, chances },
      },
    };
  });
}

/** Undo a track's close-call choice before publishing: the close call is open again (or advisory, on scores without a signal). */
export function undoCloseCall(actor: Actor | null, eventIdOrSlug: string, trackId: string) {
  return organizerMutation(actor, eventIdOrSlug, (tx, event) => {
    openForChoices(event);
    const t = trackOf(tx, event, trackId);
    const list = event.settings.closeCalls ?? [];
    const before = list.find((c) => c.trackId === t.id);
    if (!before) return { result: { trackId: t.id, undone: false }, audit: null };
    const rest = list.filter((c) => c.trackId !== t.id);
    const { closeCalls: _gone, ...others } = event.settings;
    // the last choice gone: the settings are what they were before any close call was settled
    const settings = rest.length ? { ...event.settings, closeCalls: rest } : others;
    tx.update(events).set({ settings }).where(eq(events.id, event.id)).run();
    return {
      result: { trackId: t.id, undone: true },
      audit: { action: "results.close_call_undo", eventId: event.id, targetType: "track", targetId: t.id, before: { ...before, track: t.name } },
    };
  });
}
