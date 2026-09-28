import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, events, judgeInvites, judgeTracks, scores, tracks, userRoles, users } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { FlatFlag } from "../judging/flat";
import { guardRead, mutate } from "../mutate";
import { newId, newSecret, sha256 } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { judgeSet, type ActiveOverride } from "./judging";
import { parse } from "./parse";

// Judges join an event by invitation link: the organizer names the tracks, shares
// the link (the portal mails it too when email is on and the invitation names an
// address), and whoever opens it signed in becomes a judge for those tracks. A
// link made for an email address only works for that address. Links are
// single-use; only their SHA-256 is stored.

export const InviteInput = z.object({
  name: z.string().trim().max(80).default(""),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => v === "" || z.email().safeParse(v).success, "enter an email address, or leave it empty for an open link")
    .default(""),
  trackIds: z.array(z.string().min(1)).min(1, "choose at least one track"),
});

export const TrackIds = z.object({ trackIds: z.array(z.string().min(1)).min(1, "choose at least one track") });

function eventTrackIds(db: DbOrTx, eventId: string): Set<string> {
  return new Set(db.select({ id: tracks.id }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => t.id));
}

function checkTracks(db: DbOrTx, eventId: string, ids: string[]): string[] {
  const known = eventTrackIds(db, eventId);
  const unique = [...new Set(ids)];
  if (unique.some((id) => !known.has(id))) throw new ValidationError("Check the highlighted fields.", { trackIds: ["a chosen track is not in this event"] });
  return unique.sort();
}

export function isJudgeIn(db: DbOrTx, userId: string, eventId: string): boolean {
  return Boolean(
    db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .get(),
  );
}

/** The organizer makes an invitation link. The code is returned once and never stored. */
export function inviteJudge(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      const input = parse(InviteInput, body);
      const trackIds = checkTracks(tx, event.id, input.trackIds);
      const email = input.email || null;
      if (email) {
        const existing = tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
        if (existing && isJudgeIn(tx, existing.id, event.id)) {
          throw new ConflictError("already_a_judge", `${email} is already a judge in this event.`);
        }
      }
      const id = newId("jinv");
      const code = newSecret(18);
      tx.insert(judgeInvites)
        .values({ id, eventId: event.id, codeHash: sha256(code), name: input.name, email, trackIds, createdAt: new Date().toISOString(), createdBy: actor!.userId })
        .run();
      return {
        result: { id, code, path: `/judge-invite/${code}`, email },
        // The code is a credential: the audit row names the invitation, never the code.
        audit: { action: "judge.invite", eventId: event.id, targetType: "judge_invite", targetId: id, after: { name: input.name, email, trackIds } },
      };
    },
  });
}

export function revokeJudgeInvite(actor: Actor | null, inviteId: string) {
  let invite: typeof judgeInvites.$inferSelect;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      const row = tx.select().from(judgeInvites).where(eq(judgeInvites.id, inviteId)).get();
      if (!row) throw new NotFoundError("Invitation");
      invite = row;
      return { kind: "event", event: eventFacts(requireEvent(tx, row.eventId)) };
    },
    run: (tx) => {
      if (invite.acceptedAt) throw new ConflictError("invite_used", "This invitation was already accepted; remove the judge's tracks instead.");
      if (invite.revokedAt) return { result: { id: invite.id }, audit: null };
      tx.update(judgeInvites).set({ revokedAt: new Date().toISOString() }).where(eq(judgeInvites.id, invite.id)).run();
      return {
        result: { id: invite.id },
        audit: { action: "judge.invite_revoke", eventId: invite.eventId, targetType: "judge_invite", targetId: invite.id },
      };
    },
  });
}

export type JudgeInviteView = {
  event: { id: string; slug: string; name: string };
  name: string;
  email: string | null;
  tracks: string[];
  state: "open" | "used";
};

/** What the invitation link shows. Public: the code itself is the capability. */
export function judgeInviteByCode(code: string): JudgeInviteView {
  const db = getDb();
  const row = db.select().from(judgeInvites).where(eq(judgeInvites.codeHash, sha256(code))).get();
  if (!row || row.revokedAt) throw new NotFoundError("Invitation link");
  const event = db.select({ id: events.id, slug: events.slug, name: events.name }).from(events).where(eq(events.id, row.eventId)).get()!;
  const names = row.trackIds.length
    ? db.select({ name: tracks.name }).from(tracks).where(inArray(tracks.id, row.trackIds)).orderBy(asc(tracks.position)).all().map((t) => t.name)
    : [];
  return { event, name: row.name, email: row.email, tracks: names, state: row.acceptedAt ? "used" : "open" };
}

export function acceptJudgeInvite(actor: Actor | null, code: string) {
  let invite: typeof judgeInvites.$inferSelect;
  let event: EventRow;
  return mutate({
    actor,
    action: "judge.accept_invite",
    load: (tx) => {
      const row = tx.select().from(judgeInvites).where(eq(judgeInvites.codeHash, sha256(code))).get();
      if (!row || row.revokedAt) throw new NotFoundError("Invitation link");
      invite = row;
      event = requireEvent(tx, row.eventId);
      return { kind: "judge_invite", event: eventFacts(event), email: row.email };
    },
    run: (tx) => {
      if (invite.acceptedBy === actor!.userId) return { result: { eventSlug: event.slug }, audit: null };
      if (invite.acceptedAt) throw new ConflictError("invite_used", "This invitation was already used. Ask the organizer for a new link.");
      const now = new Date().toISOString();
      const known = eventTrackIds(tx, event.id);
      const trackIds = invite.trackIds.filter((id) => known.has(id));
      tx.insert(userRoles).values({ userId: actor!.userId, eventId: event.id, role: "judge", createdAt: now }).onConflictDoNothing().run();
      for (const trackId of trackIds) {
        tx.insert(judgeTracks).values({ judgeUserId: actor!.userId, eventId: event.id, trackId }).onConflictDoNothing().run();
      }
      tx.update(judgeInvites).set({ acceptedAt: now, acceptedBy: actor!.userId }).where(eq(judgeInvites.id, invite.id)).run();
      return {
        result: { eventSlug: event.slug },
        audit: { action: "judge.join", eventId: event.id, targetType: "user", targetId: actor!.userId, after: { invite: invite.id, trackIds } },
      };
    },
  });
}

/**
 * The organizer changes a judge's tracks. Existing assignments stay in the data, but one
 * whose project is in a track the judge no longer has leaves their console and cannot be
 * saved (inJudgeTracks); a top-up run gives that project a judge from its track.
 */
export function setJudgeTracks(actor: Actor | null, eventIdOrSlug: string, judgeUserId: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => {
      if (!isJudgeIn(tx, judgeUserId, event.id)) throw new NotFoundError("Judge");
      const trackIds = checkTracks(tx, event.id, parse(TrackIds, body).trackIds);
      const before = tx
        .select({ id: judgeTracks.trackId })
        .from(judgeTracks)
        .where(and(eq(judgeTracks.judgeUserId, judgeUserId), eq(judgeTracks.eventId, event.id)))
        .all()
        .map((t) => t.id)
        .sort();
      if (before.join() === trackIds.join()) return { result: { trackIds }, audit: null };
      tx.delete(judgeTracks).where(and(eq(judgeTracks.judgeUserId, judgeUserId), eq(judgeTracks.eventId, event.id))).run();
      for (const trackId of trackIds) tx.insert(judgeTracks).values({ judgeUserId, eventId: event.id, trackId }).run();
      return {
        result: { trackIds },
        audit: { action: "judge.tracks", eventId: event.id, targetType: "user", targetId: judgeUserId, before: { trackIds: before }, after: { trackIds } },
      };
    },
  });
}

export type JudgeRow = {
  id: string;
  name: string;
  email: string;
  tracks: { id: string; name: string }[];
  assigned: number;
  done: number;
  pending: number;
  recused: number;
  lastScoredAt: string | null;
  flat: FlatFlag | null;
  override: ActiveOverride | null;
  excluded: boolean;
};

export type InviteRow = {
  id: string;
  name: string;
  email: string | null;
  tracks: string[];
  createdAt: string;
  state: "open" | "used" | "revoked";
  acceptedBy: string | null;
};

/** Every judge of an event with their tracks, progress and flags. DAL-internal. */
export function judgeRows(db: DbOrTx, eventId: string): JudgeRow[] {
  const people = db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
    .orderBy(asc(users.name))
    .all();
  const trackRows = db
    .select({ judgeId: judgeTracks.judgeUserId, id: tracks.id, name: tracks.name })
    .from(judgeTracks)
    .innerJoin(tracks, eq(tracks.id, judgeTracks.trackId))
    .where(eq(judgeTracks.eventId, eventId))
    .orderBy(asc(tracks.position))
    .all();
  const counts = db
    .select({
      judgeId: assignments.judgeUserId,
      status: assignments.status,
      n: sql<number>`count(*)`,
      last: sql<string | null>`max(${scores.submittedAt})`,
    })
    .from(assignments)
    .leftJoin(scores, eq(scores.assignmentId, assignments.id))
    .where(eq(assignments.eventId, eventId))
    .groupBy(assignments.judgeUserId, assignments.status)
    .all();
  const set = judgeSet(db, eventId);
  return people.map((p) => {
    const mine = counts.filter((c) => c.judgeId === p.id);
    const of = (s: string) => mine.find((c) => c.status === s)?.n ?? 0;
    const last = mine.map((c) => c.last).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    return {
      ...p,
      tracks: trackRows.filter((t) => t.judgeId === p.id).map(({ id, name }) => ({ id, name })),
      assigned: of("pending") + of("done"),
      done: of("done"),
      pending: of("pending"),
      recused: of("recused"),
      lastScoredAt: last,
      flat: set.flags.find((f) => f.judgeId === p.id) ?? null,
      override: [...set.overrides].reverse().find((o) => o.judgeId === p.id) ?? null,
      excluded: set.excluded.includes(p.id),
    };
  });
}

export function inviteRows(db: DbOrTx, eventId: string): InviteRow[] {
  const names = new Map(db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, eventId)).all().map((t) => [t.id, t.name]));
  return db
    .select({
      id: judgeInvites.id,
      name: judgeInvites.name,
      email: judgeInvites.email,
      trackIds: judgeInvites.trackIds,
      createdAt: judgeInvites.createdAt,
      acceptedAt: judgeInvites.acceptedAt,
      revokedAt: judgeInvites.revokedAt,
      acceptedBy: users.name,
    })
    .from(judgeInvites)
    .leftJoin(users, eq(users.id, judgeInvites.acceptedBy))
    .where(eq(judgeInvites.eventId, eventId))
    .orderBy(desc(judgeInvites.createdAt))
    .all()
    .map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      tracks: r.trackIds.map((id) => names.get(id) ?? id),
      createdAt: r.createdAt,
      state: r.revokedAt ? "revoked" : r.acceptedAt ? "used" : "open",
      acceptedBy: r.acceptedBy,
    }));
}

export function getJudges(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return {
    event,
    tracks: db.select({ id: tracks.id, name: tracks.name }).from(tracks).where(eq(tracks.eventId, event.id)).orderBy(asc(tracks.position)).all(),
    judges: judgeRows(db, event.id),
    invites: inviteRows(db, event.id),
  };
}
