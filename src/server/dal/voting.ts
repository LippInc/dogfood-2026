import "server-only";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { appendAudit } from "../audit";
import type { Actor, Resource, VoterKind } from "../authz";
import { DEFAULT_SEED_SECRET } from "../checker";
import { getDb, type DbOrTx } from "../db/client";
import { events, projects, teamMembers, teams, tracks, users, voters, votes } from "../db/schema";
import { formatUtc } from "@/lib/format";
import { AuthzError, ConflictError, NotFoundError, RateLimitedError, ValidationError } from "../errors";
import { seededRng, shuffle } from "../judging/random";
import { guardRead, mutate } from "../mutate";
import { LIMITS, take, type Limit } from "../rate-limit";
import { newId, newSecret, sha256 } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { parse, utcTimeOrEmpty } from "./parse";

// Community voting (T3). The organizer opens a window and chooses who may vote:
// signed-in accounts, people on a voter list (each gets a personal link), and/or
// anyone holding the event's open voting link. Each voter picks up to N favourite
// projects and may change the picks while the window is open. Each ballot lists the
// projects in the voter's own seeded order. While the window is open only organizers
// see the count, live; everyone else sees it once the window closes (the organizers'
// rule: "Results hidden from everyone but organizers"). Link voters are counted per browser,
// so voters sharing a network address and browser are flagged for the organizer,
// who can set a ballot aside with a reason. Every ballot change is audited.

export const DEFAULT_VOTES_PER_VOTER = 3;

export type VotingSettings = { modes: VoterKind[]; votesPerVoter: number; linkHash: string | null };
export type Client = { ip: string | null; agent: string | null };

export function votingSettings(event: EventRow): VotingSettings {
  const v = event.settings.voting;
  return { modes: v?.modes ?? [], votesPerVoter: v?.votesPerVoter ?? DEFAULT_VOTES_PER_VOTER, linkHash: v?.linkHash ?? null };
}

export type VotingState = "not_set" | "upcoming" | "open" | "closed";

export function votingState(event: Pick<EventRow, "votingOpenAt" | "votingCloseAt">, now = Date.now()): VotingState {
  if (!event.votingOpenAt || !event.votingCloseAt) return "not_set";
  if (now < Date.parse(event.votingOpenAt)) return "upcoming";
  return now < Date.parse(event.votingCloseAt) ? "open" : "closed";
}

/** Salted hashes of the client's address and browser, only ever compared with each other. */
function clientHash(value: string | null, eventId: string): string | null {
  if (!value) return null;
  return sha256(`voter-client:${process.env.DOGFOOD_SEED_SECRET || DEFAULT_SEED_SECRET}:${eventId}:${value}`);
}

type VoterRow = typeof voters.$inferSelect;

function voterByToken(db: DbOrTx, eventId: string, token: string | null): VoterRow | undefined {
  if (!token) return undefined;
  return db
    .select()
    .from(voters)
    .where(and(eq(voters.eventId, eventId), eq(voters.tokenHash, sha256(token))))
    .get();
}

function accountVoter(db: DbOrTx, eventId: string, userId: string): VoterRow | undefined {
  return db
    .select()
    .from(voters)
    .where(and(eq(voters.eventId, eventId), eq(voters.userId, userId)))
    .get();
}

/** An account voter's order seed is fixed by who they are, so the ballot looks the same before and after the first vote. */
function accountSeed(eventId: string, userId: string): number {
  return parseInt(sha256(`ballot-order:${eventId}:${userId}`).slice(0, 8), 16) & 0x7fffffff;
}

function ballotProjects(db: DbOrTx, eventId: string) {
  return db
    .select({ id: projects.id, title: projects.title, summary: projects.summary, teamName: teams.name, trackName: tracks.name })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .orderBy(asc(projects.id))
    .all();
}

/** The event's projects whose team the signed-in person is on: no vote for their own. */
function ownProjectIds(db: DbOrTx, eventId: string, userId: string): Set<string> {
  return new Set(
    db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(teamMembers, eq(teamMembers.teamId, projects.teamId))
      .where(and(eq(projects.eventId, eventId), eq(teamMembers.userId, userId)))
      .all()
      .map((p) => p.id),
  );
}

/**
 * Every submitted project of the event, mapped to the copy it counts under: itself, or
 * (after an organizer's merge) the copy it was merged into. Votes follow the merge at
 * count time, so undoing a merge gives each copy its votes back.
 */
function keptCopies(db: DbOrTx, eventId: string): Map<string, string> {
  const rows = db
    .select({ id: projects.id, duplicateOf: projects.duplicateOf })
    .from(projects)
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted")))
    .all();
  const next = new Map(rows.map((r) => [r.id, r.duplicateOf]));
  const kept = new Map<string, string>();
  for (const r of rows) {
    let id = r.id;
    for (let hops = 0; next.get(id) && hops < rows.length; hops++) id = next.get(id)!;
    kept.set(r.id, id);
  }
  return kept;
}

/**
 * The person behind a ballot, for the own-project rule: whoever is signed in, else
 * the account with a listed voter's address. An open-link voter signed out is nobody known.
 */
function voterPerson(db: DbOrTx, actor: Actor | null, who: ReturnType<typeof resolveVoter>): string | null {
  if (actor) return actor.userId;
  if (who?.kind === "listed" && who.row?.email) {
    return db.select({ id: users.id }).from(users).where(eq(users.email, who.row.email)).get()?.id ?? null;
  }
  return null;
}

/**
 * Another ballot with picks that belongs to the same known person in this event: their
 * account's, or the personal link for their account's address. Its kind, or null.
 */
function otherBallot(db: DbOrTx, eventId: string, userId: string, currentVoterId: string | null): VoterKind | null {
  const email = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;
  const rows = db
    .select({ id: voters.id, kind: voters.kind })
    .from(voters)
    .where(and(eq(voters.eventId, eventId), or(eq(voters.userId, userId), email ? and(eq(voters.kind, "listed"), eq(voters.email, email)) : undefined)))
    .all();
  for (const r of rows) {
    if (r.id !== currentVoterId && db.select({ p: votes.projectId }).from(votes).where(eq(votes.voterId, r.id)).get()) return r.kind;
  }
  return null;
}

function picksOf(db: DbOrTx, voterId: string): string[] {
  return db
    .select({ p: votes.projectId })
    .from(votes)
    .where(eq(votes.voterId, voterId))
    .orderBy(asc(votes.projectId))
    .all()
    .map((v) => v.p);
}

/** Who is voting: the event's voter token wins over the account, since a link names one ballot. */
function resolveVoter(db: DbOrTx, event: EventRow, actor: Actor | null, token: string | null) {
  const byToken = voterByToken(db, event.id, token);
  if (byToken) return { row: byToken, kind: byToken.kind, viaAccount: false } as const;
  if (actor) {
    const row = accountVoter(db, event.id, actor.userId);
    return { row: row ?? null, kind: "account" as const, viaAccount: true } as const;
  }
  return null;
}

export type BallotView = {
  event: Pick<EventRow, "id" | "slug" | "name" | "votingOpenAt" | "votingCloseAt">;
  state: VotingState;
  modes: VoterKind[];
  votesPerVoter: number;
  /** null: this request proves no voter yet */
  voter: { id: string | null; kind: VoterKind; voided: boolean } | null;
  signedIn: boolean;
  /** own: the signed-in person's team made it, so it takes no vote from them */
  projects: { id: string; title: string; summary: string; teamName: string; trackName: string; own: boolean }[];
  picks: string[];
};

/** The ballot page: public, but the picks shown are the requester's own. */
export function getBallot(actor: Actor | null, eventIdOrSlug: string, token: string | null): BallotView {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const settings = votingSettings(event);
  const who = resolveVoter(db, event, actor, token);
  const usable = who && (who.viaAccount ? settings.modes.includes("account") : true) ? who : null;
  const person = voterPerson(db, actor, who);
  const own = person ? ownProjectIds(db, event.id, person) : new Set<string>();
  const list = ballotProjects(db, event.id).map((p) => ({ ...p, own: own.has(p.id) }));
  const seed = usable?.row?.orderSeed ?? (actor && usable ? accountSeed(event.id, actor.userId) : null);
  return {
    event: { id: event.id, slug: event.slug, name: event.name, votingOpenAt: event.votingOpenAt, votingCloseAt: event.votingCloseAt },
    state: votingState(event),
    modes: settings.modes,
    votesPerVoter: settings.votesPerVoter,
    voter: usable ? { id: usable.row?.id ?? null, kind: usable.kind, voided: Boolean(usable.row?.voidedAt) } : null,
    signedIn: Boolean(actor),
    projects: seed === null ? list : shuffle(list, seededRng(seed)),
    picks: usable?.row ? foldPicks(keptCopies(db, event.id), picksOf(db, usable.row.id)) : [],
  };
}

/** Picks as the voter sees them now: a merged copy shows as the copy it counts under, once. */
function foldPicks(kept: Map<string, string>, ids: string[]): string[] {
  return [...new Set(ids.map((id) => kept.get(id) ?? id))].sort();
}

function limitOrThrow(key: string, limit: Limit, audit: { eventId: string; label: string; userId: string | null; what: string }) {
  const t = take(key, limit);
  if (t.ok) return;
  if (t.firstRefusal) {
    // One audit row when a key first runs dry, not one per refused request.
    getDb().transaction((tx) => {
      appendAudit(
        tx,
        { actorUserId: audit.userId, actorLabel: audit.label, action: "ratelimit.refused", eventId: audit.eventId, targetType: "limit", targetId: audit.what, after: { retryAfter: t.retryAfter } },
        new Date().toISOString(),
      );
    });
  }
  throw new RateLimitedError(t.retryAfter);
}

export const BallotInput = z.object({ projectIds: z.array(z.string().min(1)).max(50) });

export function castBallot(actor: Actor | null, eventIdOrSlug: string, token: string | null, body: unknown, client: Client) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const settings = votingSettings(event);
  const who = resolveVoter(db, event, actor, token);
  const voterLabel = who && !who.viaAccount ? `${who.kind === "listed" ? "Listed" : "Link"} voter ${who.row.id.slice(-6)}` : null;
  // An account voter keeps one bucket from the first save on (before it, there is no voter row).
  const limitKey = who?.viaAccount && actor ? `user:${actor.userId}` : (who?.row?.id ?? `anon:${clientHash(client.ip, event.id)}`);
  limitOrThrow(`ballot:${limitKey}`, LIMITS.ballot, {
    eventId: event.id,
    label: actor && who?.viaAccount ? actor.name : (voterLabel ?? "anonymous"),
    userId: actor && who?.viaAccount ? actor.userId : null,
    what: "ballot",
  });
  return mutate({
    actor: who?.viaAccount ? actor : null,
    as: voterLabel ? { label: voterLabel } : null,
    action: "vote.cast",
    load: (): Resource => ({
      kind: "ballot",
      event: eventFacts(event),
      modes: settings.modes,
      voter: who ? { id: who.row?.id ?? "new", kind: who.kind, voided: Boolean(who.row?.voidedAt) } : null,
    }),
    run: (tx) => {
      const ids = foldPicks(keptCopies(tx, event.id), parse(BallotInput, body).projectIds);
      if (ids.length > settings.votesPerVoter) {
        throw new ValidationError(`Pick at most ${settings.votesPerVoter} projects.`, { projectIds: [`at most ${settings.votesPerVoter}`] });
      }
      const valid = new Set(ballotProjects(tx, event.id).map((p) => p.id));
      if (ids.some((id) => !valid.has(id))) throw new ValidationError("Check the picks.", { projectIds: ["a pick is not a project on this ballot"] });
      // Whoever is known (signed in, or listed by an account's address): no vote for their own team.
      const person = voterPerson(tx, actor, who);
      if (person) {
        const own = ownProjectIds(tx, event.id, person);
        if (ids.some((id) => own.has(id))) {
          throw new ValidationError("You cannot vote for your own team's project.", { projectIds: ["your own team's project"] });
        }
        // One known person, one ballot: someone on the voter list who also has an account
        // keeps their picks on the ballot they started (emptying it frees the other).
        const elsewhere = ids.length ? otherBallot(tx, event.id, person, who?.row?.id ?? null) : null;
        if (elsewhere) {
          throw new ConflictError("already_voted", `You already voted ${elsewhere === "account" ? "while signed in" : "with your personal link"}; change your picks there.`);
        }
      }
      const now = new Date().toISOString();
      let voter = who!.row;
      if (!voter) {
        voter = {
          id: newId("vtr"),
          eventId: event.id,
          kind: "account",
          userId: actor!.userId,
          email: null,
          tokenHash: null,
          orderSeed: accountSeed(event.id, actor!.userId),
          ipHash: clientHash(client.ip, event.id),
          agentHash: clientHash(client.agent, event.id),
          createdAt: now,
          lastVotedAt: null,
          voidedAt: null,
          voidedBy: null,
          voidReason: null,
        };
        tx.insert(voters).values(voter).run();
      }
      const before = picksOf(tx, voter.id);
      if (before.join() === ids.join()) return { result: { voterId: voter.id, picks: ids }, audit: null };
      tx.delete(votes).where(eq(votes.voterId, voter.id)).run();
      for (const projectId of ids) tx.insert(votes).values({ voterId: voter.id, projectId, createdAt: now }).run();
      tx.update(voters)
        .set({
          lastVotedAt: now,
          ipHash: voter.ipHash ?? clientHash(client.ip, event.id),
          agentHash: voter.agentHash ?? clientHash(client.agent, event.id),
        })
        .where(eq(voters.id, voter.id))
        .run();
      return {
        result: { voterId: voter.id, picks: ids },
        audit: { action: "vote.cast", eventId: event.id, targetType: "voter", targetId: voter.id, before: { picks: before }, after: { picks: ids } },
      };
    },
  });
}

/**
 * Entering through a link: the event's open link makes a new link voter (one per
 * browser, limited per network address); a personal link is the listed voter's own
 * token. Returns the token for the browser to keep.
 */
export function enterVoting(code: string, client: Client): { eventSlug: string; eventId: string; token: string } {
  const db = getDb();
  const hash = sha256(code);
  const listed = db.select().from(voters).where(eq(voters.tokenHash, hash)).get();
  if (listed) {
    const event = requireEvent(db, listed.eventId);
    return { eventSlug: event.slug, eventId: event.id, token: code };
  }
  const event = db
    .select()
    .from(events)
    .all()
    .find((e) => e.settings.voting?.linkHash === hash);
  if (!event || !votingSettings(event).modes.includes("link")) throw new NotFoundError("Voting link");
  // The entry limit comes first, so refused entries after the close cannot grow the log
  // without bound either (the link is public).
  const ipHash = clientHash(client.ip, event.id);
  limitOrThrow(`linkvoter:${event.id}:${ipHash ?? "none"}`, LIMITS.linkVoter, { eventId: event.id, label: "anonymous", userId: null, what: "open-link entry" });
  // after the close nobody new comes in: the same refusal a late ballot gets, logged like every 403
  if (votingState(event) === "closed") {
    db.transaction((tx) => {
      appendAudit(
        tx,
        {
          actorUserId: null,
          actorLabel: "anonymous",
          action: "authz.refused",
          eventId: event.id,
          targetType: "event",
          targetId: event.id,
          after: { attempted: "voting.enter", status: 403, code: "voting_closed" },
        },
        new Date().toISOString(),
      );
    });
    throw new AuthzError({ ok: false, status: 403, code: "voting_closed", message: `Voting closed at ${formatUtc(event.votingCloseAt)}.` });
  }
  const token = newSecret(24);
  const id = newId("vtr");
  db.transaction((tx) => {
    tx.insert(voters)
      .values({
        id,
        eventId: event.id,
        kind: "link",
        tokenHash: sha256(token),
        orderSeed: parseInt(sha256(`ballot-order:${id}`).slice(0, 8), 16) & 0x7fffffff,
        ipHash,
        agentHash: clientHash(client.agent, event.id),
        createdAt: new Date().toISOString(),
      })
      .run();
    appendAudit(
      tx,
      { actorUserId: null, actorLabel: `Link voter ${id.slice(-6)}`, action: "voter.join_link", eventId: event.id, targetType: "voter", targetId: id },
      new Date().toISOString(),
    );
  });
  return { eventSlug: event.slug, eventId: event.id, token };
}

// ---------------------------------------------------------------------------
// The organizer's side
// ---------------------------------------------------------------------------


export const SettingsInput = z
  .object({
    votingOpenAt: utcTimeOrEmpty,
    votingCloseAt: utcTimeOrEmpty,
    modes: z.array(z.enum(["account", "listed", "link"])).default([]),
    votesPerVoter: z.coerce.number().int().min(1).max(20),
  })
  .refine((v) => (v.votingOpenAt === "") === (v.votingCloseAt === ""), { message: "set both times or neither", path: ["votingCloseAt"] })
  .refine((v) => !v.votingOpenAt || Date.parse(v.votingOpenAt) < Date.parse(v.votingCloseAt), { message: "must be after voting opens", path: ["votingCloseAt"] });

function organizer<T>(actor: Actor | null, eventIdOrSlug: string, run: (tx: DbOrTx, event: EventRow) => { result: T; audit: Parameters<typeof mutate<T>>[0]["run"] extends (tx: never) => { audit: infer A } ? A : never }) {
  let event: EventRow;
  return mutate<T>({
    actor,
    action: "event.manage",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "event", event: eventFacts(event) };
    },
    run: (tx) => run(tx, event),
  });
}

/**
 * Once the window has closed the count is public, so it is final: the window can no
 * longer move (which would hide the count again and let more ballots in) and no
 * ballot can be set aside or restored.
 */
function voteFinal(event: EventRow) {
  if (votingState(event) === "closed")
    throw new ConflictError("voting_closed", `Voting closed ${formatUtc(event.votingCloseAt)}; the window and the count are final.`);
}

export function saveVotingSettings(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizer(actor, eventIdOrSlug, (tx, event) => {
    voteFinal(event);
    const input = parse(SettingsInput, body);
    // Saved ballots are counted as they stand, so the pick limit can rise but never drop
    // below the largest one (voided ones included: they can be restored).
    const largest = Math.max(
      0,
      ...tx
        .select({ n: sql<number>`count(*)` })
        .from(votes)
        .innerJoin(voters, eq(voters.id, votes.voterId))
        .where(eq(voters.eventId, event.id))
        .groupBy(votes.voterId)
        .all()
        .map((r) => r.n),
    );
    if (input.votesPerVoter < largest) {
      throw new ConflictError("ballots_too_large", `A ballot already holds ${largest} picks, so the limit can go up but not below ${largest}.`);
    }
    const before = { votingOpenAt: event.votingOpenAt, votingCloseAt: event.votingCloseAt, ...votingSettings(event), linkHash: undefined };
    const voting = { ...votingSettings(event), modes: [...new Set(input.modes)].sort() as VoterKind[], votesPerVoter: input.votesPerVoter };
    tx.update(events)
      .set({ votingOpenAt: input.votingOpenAt || null, votingCloseAt: input.votingCloseAt || null, settings: { ...event.settings, voting } })
      .where(eq(events.id, event.id))
      .run();
    return {
      result: { ok: true },
      audit: {
        action: "voting.settings",
        eventId: event.id,
        targetType: "event",
        targetId: event.id,
        before,
        after: { votingOpenAt: input.votingOpenAt || null, votingCloseAt: input.votingCloseAt || null, modes: voting.modes, votesPerVoter: voting.votesPerVoter },
      },
    };
  });
}

/** A new open voting link; the old one stops working. The code is shown once. */
export function makeVotingLink(actor: Actor | null, eventIdOrSlug: string) {
  return organizer(actor, eventIdOrSlug, (tx, event) => {
    voteFinal(event);
    const code = newSecret(18);
    const current = votingSettings(event);
    tx.update(events)
      .set({ settings: { ...event.settings, voting: { ...current, linkHash: sha256(code) } } })
      .where(eq(events.id, event.id))
      .run();
    return {
      result: { code, path: `/vote/${code}` },
      audit: { action: "voting.link", eventId: event.id, targetType: "event", targetId: event.id, after: { replaced: Boolean(current.linkHash) } },
    };
  });
}

export const VoterList = z.object({ emails: z.string().max(200_000) });

/** Add people to the voter list; each gets a personal link, shown once. Known addresses are skipped. */
export function addListedVoters(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizer(actor, eventIdOrSlug, (tx, event) => {
    voteFinal(event);
    const raw = parse(VoterList, body).emails;
    const emails = [...new Set(raw.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const bad = emails.filter((e) => !z.email().safeParse(e).success);
    if (bad.length) throw new ValidationError("Check the addresses.", { emails: [`not an email address: ${bad.slice(0, 3).join(", ")}`] });
    if (emails.length === 0) throw new ValidationError("Check the addresses.", { emails: ["paste at least one address"] });
    const existing = new Set(
      tx
        .select({ email: voters.email })
        .from(voters)
        .where(and(eq(voters.eventId, event.id), inArray(voters.email, emails)))
        .all()
        .map((v) => v.email),
    );
    const now = new Date().toISOString();
    const links: { email: string; path: string }[] = [];
    for (const email of emails) {
      if (existing.has(email)) continue;
      const token = newSecret(24);
      const id = newId("vtr");
      tx.insert(voters)
        .values({ id, eventId: event.id, kind: "listed", email, tokenHash: sha256(token), orderSeed: parseInt(sha256(`ballot-order:${id}`).slice(0, 8), 16) & 0x7fffffff, createdAt: now })
        .run();
      links.push({ email, path: `/vote/${token}` });
    }
    return {
      result: { links, skipped: emails.length - links.length },
      audit: links.length
        ? { action: "voting.voters_added", eventId: event.id, targetType: "event", targetId: event.id, after: { added: links.length, skipped: emails.length - links.length } }
        : null,
    };
  });
}

export const VoidInput = z.object({ voterId: z.string().min(1), reason: z.string().trim().min(3, "say why, in a few words").max(500) });

/** Set a ballot aside (a suspected duplicate), with a reason; its votes stop counting. */
export function voidVoter(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizer(actor, eventIdOrSlug, (tx, event) => {
    voteFinal(event);
    const { voterId, reason } = parse(VoidInput, body);
    const v = tx.select().from(voters).where(and(eq(voters.id, voterId), eq(voters.eventId, event.id))).get();
    if (!v) throw new NotFoundError("Voter");
    if (v.voidedAt) return { result: { voterId }, audit: null };
    tx.update(voters).set({ voidedAt: new Date().toISOString(), voidedBy: actor!.userId, voidReason: reason }).where(eq(voters.id, voterId)).run();
    return { result: { voterId }, audit: { action: "voter.void", eventId: event.id, targetType: "voter", targetId: voterId, after: { reason } } };
  });
}

export const RestoreInput = z.object({ voterId: z.string().min(1) });

export function restoreVoter(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizer(actor, eventIdOrSlug, (tx, event) => {
    voteFinal(event);
    const { voterId } = parse(RestoreInput, body);
    const v = tx.select().from(voters).where(and(eq(voters.id, voterId), eq(voters.eventId, event.id))).get();
    if (!v) throw new NotFoundError("Voter");
    if (!v.voidedAt) return { result: { voterId }, audit: null };
    tx.update(voters).set({ voidedAt: null, voidedBy: null, voidReason: null }).where(eq(voters.id, voterId)).run();
    return { result: { voterId }, audit: { action: "voter.restore", eventId: event.id, targetType: "voter", targetId: voterId, before: { reason: v.voidReason } } };
  });
}

export type Tally = { projectId: string; title: string; teamName: string; votes: number; place: number };

/**
 * Counted votes per project. Voided voters are left out; a vote on a merged copy counts
 * for the copy it was merged into, once per voter; and a vote a known person gave a
 * project whose team they are on (they joined it after voting) does not count.
 * DAL-internal; callers decide who may see it.
 */
function tally(db: DbOrTx, eventId: string): Tally[] {
  const kept = keptCopies(db, eventId);
  const rows = db
    .select({ id: projects.id, title: projects.title, teamId: projects.teamId, teamName: teams.name })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .all();
  const teamOf = new Map(rows.map((r) => [r.id, r.teamId]));
  const teamsOf = new Map<string, Set<string>>();
  for (const m of db.select({ userId: teamMembers.userId, teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.eventId, eventId)).all()) {
    teamsOf.set(m.userId, (teamsOf.get(m.userId) ?? new Set()).add(m.teamId));
  }
  const byEmail = new Map(
    db
      .select({ id: users.id, email: users.email })
      .from(users)
      .innerJoin(voters, eq(voters.email, users.email))
      .where(eq(voters.eventId, eventId))
      .all()
      .map((u) => [u.email, u.id]),
  );
  const counted = new Map<string, Set<string>>(); // kept project -> voters
  for (const v of db
    .select({ voterId: votes.voterId, projectId: votes.projectId, userId: voters.userId, email: voters.email })
    .from(votes)
    .innerJoin(voters, eq(voters.id, votes.voterId))
    .where(and(eq(voters.eventId, eventId), isNull(voters.voidedAt)))
    .all()) {
    const project = kept.get(v.projectId);
    if (!project || !teamOf.has(project)) continue;
    const person = v.userId ?? (v.email ? byEmail.get(v.email) : undefined);
    if (person && teamsOf.get(person)?.has(teamOf.get(project)!)) continue;
    counted.set(project, (counted.get(project) ?? new Set()).add(v.voterId));
  }
  const list = rows
    .map((r) => ({ projectId: r.id, title: r.title, teamName: r.teamName, n: counted.get(r.id)?.size ?? 0 }))
    .sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
  return list.map((r) => ({ projectId: r.projectId, title: r.title, teamName: r.teamName, votes: r.n, place: list.findIndex((x) => x.n === r.n) + 1 }));
}

export type DuplicateGroup = { key: string; voters: { id: string; kind: VoterKind; picks: number; createdAt: string; voided: boolean }[] };

export function getVotingAdmin(actor: Actor | null, eventIdOrSlug: string) {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const settings = votingSettings(event);
  const all = db.select().from(voters).where(eq(voters.eventId, event.id)).all();
  const counts = new Map(
    db
      .select({ voterId: votes.voterId, n: sql<number>`count(*)` })
      .from(votes)
      .innerJoin(voters, eq(voters.id, votes.voterId))
      .where(eq(voters.eventId, event.id))
      .groupBy(votes.voterId)
      .all()
      .map((r) => [r.voterId, r.n]),
  );
  // Suspected duplicates: two or more ballots from the same network address and browser.
  const groups = new Map<string, VoterRow[]>();
  for (const v of all) {
    if (!v.ipHash || !(counts.get(v.id) ?? 0)) continue;
    const key = `${v.ipHash}:${v.agentHash ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const suspected: DuplicateGroup[] = [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => ({
      key: key.slice(0, 8),
      voters: list.map((v) => ({ id: v.id, kind: v.kind, picks: counts.get(v.id) ?? 0, createdAt: v.createdAt, voided: Boolean(v.voidedAt) })),
    }));
  const state = votingState(event);
  return {
    event,
    settings: { modes: settings.modes, votesPerVoter: settings.votesPerVoter, linkActive: Boolean(settings.linkHash) },
    state,
    turnout: {
      voters: all.length,
      ballots: all.filter((v) => (counts.get(v.id) ?? 0) > 0 && !v.voidedAt).length,
      voided: all.filter((v) => v.voidedAt).length,
      byKind: (["account", "listed", "link"] as const).map((kind) => ({ kind, ballots: all.filter((v) => v.kind === kind && (counts.get(v.id) ?? 0) > 0 && !v.voidedAt).length })),
    },
    listed: all
      .filter((v) => v.kind === "listed")
      .map((v) => ({ id: v.id, email: v.email!, voted: (counts.get(v.id) ?? 0) > 0, voided: Boolean(v.voidedAt) }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    suspected,
    // Live for organizers while the window is open; everyone else waits for the close.
    tally: state === "open" || state === "closed" ? tally(db, event.id) : null,
  };
}

export type CommunityResults = { state: VotingState; closesAt: string | null; tally: Tally[] | null };

/** The public community vote: only after the window closes (organizers see it live in getVotingAdmin). */
export function getCommunityResults(eventIdOrSlug: string): CommunityResults {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const state = votingState(event);
  return { state, closesAt: event.votingCloseAt, tally: state === "closed" ? tally(db, event.id) : null };
}

/** What a voting link is, without using it: link previews and bots fetch URLs, so entering takes a click. */
export function describeVotingCode(code: string): { event: { id: string; slug: string; name: string }; kind: "listed" | "link"; state: VotingState; closesAt: string | null } {
  const db = getDb();
  const hash = sha256(code);
  const listed = db.select({ eventId: voters.eventId }).from(voters).where(eq(voters.tokenHash, hash)).get();
  const event = listed
    ? requireEvent(db, listed.eventId)
    : db
        .select()
        .from(events)
        .all()
        .find((e) => e.settings.voting?.linkHash === hash && votingSettings(e).modes.includes("link"));
  if (!event) throw new NotFoundError("Voting link");
  return { event: { id: event.id, slug: event.slug, name: event.name }, kind: listed ? "listed" : "link", state: votingState(event), closesAt: event.votingCloseAt };
}

/** The cookie that carries a voter's token for one event. */
export const voteCookieName = (eventId: string) => `vote_${eventId}`;
