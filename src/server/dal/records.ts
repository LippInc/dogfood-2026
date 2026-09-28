import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { competitionPlaces, ordinal } from "@/lib/places";
import { appendAudit, anchorHolds, chainHead, type ChainAnchor } from "../audit";
import type { Actor, Resource } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { assignments, comparisons, projects, RECORD_KINDS, signedRecords, teamMembers, teams, tracks, users, type RecordKind, type SignedEnvelope } from "../db/schema";
import { NotFoundError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { ensureSigningKey, publishedKeys, signRecord, verifyEnvelope, type PublishedKey, type Verification } from "../signing";
import { canonicalJson, newId, nowIso } from "../util";
import { eventFacts, requireEvent, type PublicEvent } from "./events";
import { getPublishedResults } from "./results";
import { parse } from "./parse";
import { getCommunityResults } from "./voting-organizer";
import { shownTitle } from "./project-fields";

// Signed records: a judge's participation record and a team member's certificate.
// Each is issued once per person, event and kind, after the results are published,
// and signed with the portal's Ed25519 key (../signing.ts). The record says only
// what the person would put on a CV: their name, the event, and what they did
// there. It never carries scores, emails or other people's names.

export const RECORD_FORMAT = "dogfood-record/v1";

type EventRow = ReturnType<typeof requireEvent>;

export function issuer(): string {
  return (process.env.PUBLIC_URL ?? "http://localhost:8080").replace(/\/+$/, "");
}

/** A judge's finished reviews and pairwise answers (taken-back ones not counted) in an event, and the tracks they covered. */
function judgeFacts(db: DbOrTx, eventId: string, userId: string) {
  const rows = db
    .select({ status: assignments.status, track: tracks.name })
    .from(assignments)
    .innerJoin(projects, eq(projects.id, assignments.projectId))
    .leftJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(assignments.eventId, eventId), eq(assignments.judgeUserId, userId)))
    .all();
  const done = rows.filter((r) => r.status === "done");
  const answered = db
    .select({ track: tracks.name })
    .from(comparisons)
    .innerJoin(tracks, eq(tracks.id, comparisons.trackId))
    .where(and(eq(comparisons.eventId, eventId), eq(comparisons.judgeUserId, userId), isNull(comparisons.voidedAt)))
    .all();
  const covered = [...done.map((r) => r.track), ...answered.map((r) => r.track)].filter((t): t is string => Boolean(t));
  return { finishedReviews: done.length, answers: answered.length, tracks: [...new Set(covered)].sort() };
}

/** The person's team in an event and its submitted project (the kept copy, if it was entered twice). */
function memberFacts(db: DbOrTx, eventId: string, userId: string) {
  const row = db
    .select({ teamName: teams.name, projectId: projects.id, title: shownTitle(), trackId: projects.trackId, trackName: tracks.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .innerJoin(projects, and(eq(projects.teamId, teams.id), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .leftJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
    .get();
  return row ?? null;
}

/** Podium places (1st to 3rd in the project's track) and a community-vote win; nothing below the podium. */
function awards(event: EventRow, projectId: string): string[] {
  const out: string[] = [];
  const results = getPublishedResults(event.id);
  if (results.published) {
    for (const t of results.tracks) {
      const i = t.rows.findIndex((r) => r.projectId === projectId);
      if (i < 0) continue;
      const p = competitionPlaces(t.rows)[i]!;
      if (p.place !== null && p.place <= 3) out.push(`${p.joint ? "Joint " : ""}${ordinal(p.place)} place, ${t.name}`);
    }
  }
  const community = getCommunityResults(event.id);
  const mine = community.tally?.find((r) => r.projectId === projectId);
  if (mine && mine.votes > 0 && mine.place === 1) {
    const shared = community.tally!.filter((r) => r.place === 1).length > 1;
    out.push(shared ? "Joint winner of the community vote" : "Winner of the community vote");
  }
  return out;
}

function buildRecord(
  db: DbOrTx,
  event: EventRow,
  userId: string,
  kind: RecordKind,
  id: string,
  keyId: string,
  issuedAt: string,
  auditLog: ChainAnchor | null,
): Record<string, unknown> {
  const person = db.select({ name: users.name }).from(users).where(eq(users.id, userId)).get();
  const base = {
    format: RECORD_FORMAT,
    id,
    kind,
    issuer: issuer(),
    keyId,
    issuedAt,
    // The audit log's newest entry when the record was signed: whoever holds the record
    // holds a signed copy of that entry's hash, so a later rewrite of the log shows.
    ...(auditLog ? { auditLog } : {}),
    event: { id: event.id, name: event.name, slug: event.slug, resultsPublishedAt: event.resultsPublishedAt },
    person: { name: person?.name ?? "Unknown" },
  };
  if (kind === "judge") {
    const j = judgeFacts(db, event.id, userId);
    // A record from a scores-only event keeps its exact shape; pairwise answers add one field.
    return { ...base, judging: { finishedReviews: j.finishedReviews, tracks: j.tracks, ...(j.answers ? { answers: j.answers } : {}) } };
  }
  const m = memberFacts(db, event.id, userId)!;
  return { ...base, project: { id: m.projectId, title: m.title, team: m.teamName, track: m.trackName ?? null, awards: awards(event, m.projectId) } };
}

type Issued = { id: string; created: boolean };

/** Issue the record unless it exists. Runs inside the caller's transaction, after authorize(). */
function issueIn(tx: DbOrTx, event: EventRow, userId: string, kind: RecordKind, now: string): Issued {
  const existing = tx
    .select({ id: signedRecords.id })
    .from(signedRecords)
    .where(and(eq(signedRecords.eventId, event.id), eq(signedRecords.kind, kind), eq(signedRecords.userId, userId)))
    .get();
  if (existing) return { id: existing.id, created: false };
  const key = ensureSigningKey(tx, now);
  const id = newId("rec", 16);
  const envelope = signRecord(key, buildRecord(tx, event, userId, kind, id, key.id, now, chainHead(tx)));
  tx.insert(signedRecords).values({ id, eventId: event.id, kind, userId, keyId: key.id, envelope, issuedAt: now }).run();
  return { id, created: true };
}

function subject(tx: DbOrTx, event: EventRow, actor: Actor | null, kind: RecordKind): Resource {
  return {
    kind: "record_subject",
    event: eventFacts(event),
    recordKind: kind,
    ...(() => {
      const j = actor ? judgeFacts(tx, event.id, actor.userId) : null;
      return { finishedReviews: j?.finishedReviews ?? 0, answers: j?.answers ?? 0 };
    })(),
    onSubmittedTeam: actor ? memberFacts(tx, event.id, actor.userId) !== null : false,
  };
}

/** The actor's own judging record or certificate: issued on first ask, the same record after that. */
export function issueOwnRecord(actor: Actor | null, eventIdOrSlug: string, kind: RecordKind): Issued {
  const { id: eventId } = requireEvent(getDb(), eventIdOrSlug);
  const now = nowIso();
  return mutate({
    actor,
    action: "record.issue_own",
    load: (tx) => subject(tx, requireEvent(tx, eventId), actor, kind),
    run: (tx) => {
      const issued = issueIn(tx, requireEvent(tx, eventId), actor!.userId, kind, now);
      return {
        result: issued,
        audit: issued.created ? { action: "record.issue", eventId, targetType: "record", targetId: issued.id, after: { kind, subject: actor!.userId } } : null,
      };
    },
  });
}

export const RecordRequest = z.object({ kind: z.enum(RECORD_KINDS) });

/** The JSON route's form: { kind: "judge" | "participant" }. */
export function issueOwnRecordRequest(actor: Actor | null, eventIdOrSlug: string, body: unknown): Issued {
  const { kind } = parse(RecordRequest, body);
  return issueOwnRecord(actor, eventIdOrSlug, kind);
}

/** Organizers: issue every judge's record and every team member's certificate that is not issued yet. */
export function issueAllRecords(actor: Actor | null, eventIdOrSlug: string): { judges: number; participants: number } {
  const { id: eventId } = requireEvent(getDb(), eventIdOrSlug);
  const now = nowIso();
  return mutate({
    actor,
    action: "records.issue_all",
    load: (tx) => ({ kind: "event", event: eventFacts(requireEvent(tx, eventId)) }),
    run: (tx) => {
      const event = requireEvent(tx, eventId);
      // Judges with a finished review or a pairwise answer that was not taken back.
      const judgeIds = [
        ...new Set([
          ...tx
            .select({ userId: assignments.judgeUserId })
            .from(assignments)
            .where(and(eq(assignments.eventId, eventId), eq(assignments.status, "done")))
            .all()
            .map((r) => r.userId),
          ...tx
            .select({ userId: comparisons.judgeUserId })
            .from(comparisons)
            .where(and(eq(comparisons.eventId, eventId), isNull(comparisons.voidedAt)))
            .all()
            .map((r) => r.userId),
        ]),
      ];
      const memberIds = tx
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .innerJoin(projects, and(eq(projects.teamId, teamMembers.teamId), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
        .where(eq(teamMembers.eventId, eventId))
        .all()
        .map((r) => r.userId);
      const made = { judges: 0, participants: 0 };
      const issue = (userId: string, kind: RecordKind) => {
        const issued = issueIn(tx, event, userId, kind, now);
        if (!issued.created) return;
        made[kind === "judge" ? "judges" : "participants"]++;
        appendAudit(
          tx,
          { actorUserId: actor!.userId, actorLabel: actor!.name, action: "record.issue", eventId, targetType: "record", targetId: issued.id, after: { kind, subject: userId } },
          now,
        );
      };
      judgeIds.forEach((u) => issue(u, "judge"));
      [...new Set(memberIds)].forEach((u) => issue(u, "participant"));
      return { result: made, audit: made.judges + made.participants ? { action: "records.issue_all", eventId, targetType: "event", targetId: eventId, after: made } : null };
    },
  });
}

export type RecordView = {
  id: string;
  kind: RecordKind;
  event: PublicEvent;
  envelope: SignedEnvelope;
  /** The exact text that was signed: the record's canonical JSON. */
  signedText: string;
  verification: Verification;
  keys: PublishedKey[];
  /** the audit log entry the record pins, and whether the log still holds it as signed */
  anchor: (ChainAnchor & { holds: boolean }) | null;
};

/** A record by its id, with this portal's own check of its signature. Public: the id is the share link. */
export function getRecord(id: string): RecordView {
  const db = getDb();
  const row = db.select().from(signedRecords).where(eq(signedRecords.id, id)).get();
  if (!row) throw new NotFoundError("Record");
  const event = requireEvent(db, row.eventId);
  const keys = publishedKeys(db);
  const { id: eventId, slug, name, description, submissionsOpenAt, submissionsCloseAt, judgingCloseAt, resultsPublishedAt, votingOpenAt, votingCloseAt } = event;
  return {
    id: row.id,
    kind: row.kind,
    event: { id: eventId, slug, name, description, submissionsOpenAt, submissionsCloseAt, judgingCloseAt, resultsPublishedAt, votingOpenAt, votingCloseAt },
    envelope: row.envelope,
    signedText: canonicalJson(row.envelope.record),
    verification: verifyEnvelope(row.envelope, keys),
    keys,
    anchor: (() => {
      const a = (row.envelope.record as { auditLog?: ChainAnchor }).auditLog;
      return a ? { ...a, holds: anchorHolds(db, a) } : null;
    })(),
  };
}

/** Check any envelope against this portal's published keys. Public. */
export function verifyRecord(envelope: unknown): Verification {
  return verifyEnvelope(envelope, publishedKeys(getDb()));
}

export function keysDocument() {
  return { issuer: issuer(), format: RECORD_FORMAT, keys: publishedKeys(getDb()) };
}

/** The actor's own records in an event (for the judge console and the team page). */
export function myRecords(actor: Actor | null, eventIdOrSlug: string): { id: string; kind: RecordKind }[] {
  if (!actor) return [];
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  return db
    .select({ id: signedRecords.id, kind: signedRecords.kind })
    .from(signedRecords)
    .where(and(eq(signedRecords.eventId, event.id), eq(signedRecords.userId, actor.userId)))
    .all();
}

/** Organizers: every record issued for the event, with whom it is about. */
export function listRecords(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return db
    .select({ id: signedRecords.id, kind: signedRecords.kind, name: users.name, issuedAt: signedRecords.issuedAt })
    .from(signedRecords)
    .innerJoin(users, eq(users.id, signedRecords.userId))
    .where(eq(signedRecords.eventId, event.id))
    .orderBy(signedRecords.kind, users.name)
    .all();
}
