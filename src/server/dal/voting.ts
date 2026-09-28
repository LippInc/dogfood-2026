import "server-only";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { appendAudit } from "../audit";
import type { Actor, Resource, VoterKind } from "../authz";
import { DEFAULT_SEED_SECRET } from "../checker";
import { getDb, type DbOrTx } from "../db/client";
import { events, projects, teamMembers, teams, tracks, users, voters, votes } from "../db/schema";
import { formatUtc } from "@/lib/format";
import { withoutHidden } from "@/lib/project-fields";
import { fieldModes, shownTitle } from "./project-fields";
import { AuthzError, ConflictError, NotFoundError, RateLimitedError, ValidationError } from "../errors";
import { seededRng, shuffle } from "../judging/random";
import { mutate } from "../mutate";
import { LIMITS, peek, takeAudited, type Limit } from "../rate-limit";
import { newId, newSecret, sha256 } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { parse } from "./parse";

// Community voting (T3). The organizer opens a window and chooses who may vote:
// signed-in accounts, people on a voter list (each gets a personal link), and/or
// anyone holding the event's open voting link. Each voter picks up to N favourite
// projects and may change the picks while the window is open. Each ballot lists the
// projects in the voter's own seeded order. While the window is open only organizers
// see the count, live; everyone else sees it once the window closes (the organizers'
// rule: "Results hidden from everyone but organizers"). Link voters are counted per browser,
// so voters sharing a network address and browser are flagged for the organizer,
// who can set a ballot aside with a reason. Every ballot change is audited.
// Nobody can tell who holds the open link, so its ballots are counted apart: they add to
// the result only if the organizer said so before the first ballot came in (countLink),
// and every count shows them in their own column either way.
// This file is the voter's side; the organizer's side is in voting-organizer.ts.

export const DEFAULT_VOTES_PER_VOTER = 3;

export type VotingSettings = { modes: VoterKind[]; votesPerVoter: number; linkHash: string | null; countLink: boolean };
export type Client = { ip: string | null; agent: string | null };

export function votingSettings(event: EventRow): VotingSettings {
  const v = event.settings.voting;
  return { modes: v?.modes ?? [], votesPerVoter: v?.votesPerVoter ?? DEFAULT_VOTES_PER_VOTER, linkHash: v?.linkHash ?? null, countLink: v?.countLink ?? false };
}

/** Whether anyone has saved picks in this event yet: from the first ballot on, the counting rule is fixed. */
export function anyBallotCast(db: DbOrTx, eventId: string): boolean {
  return Boolean(
    db
      .select({ id: voters.id })
      .from(voters)
      .where(and(eq(voters.eventId, eventId), isNotNull(voters.lastVotedAt)))
      .get(),
  );
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

export type VoterRow = typeof voters.$inferSelect;

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

/** A ballot's order seed: a hash of the voter, so the same voter always sees the same order. */
function ballotSeed(voter: string): number {
  return parseInt(sha256(`ballot-order:${voter}`).slice(0, 8), 16) & 0x7fffffff;
}

/** An account voter's order seed is fixed by who they are, so the ballot looks the same before and after the first vote. */
function accountSeed(eventId: string, userId: string): number {
  return ballotSeed(`${eventId}:${userId}`);
}

function ballotProjects(db: DbOrTx, eventId: string) {
  const modes = fieldModes(db, eventId);
  const rows = db
    .select({ id: projects.id, title: shownTitle(), summary: projects.summary, teamName: teams.name, trackName: tracks.name })
    .from(projects)
    .innerJoin(teams, eq(teams.id, projects.teamId))
    .innerJoin(tracks, eq(tracks.id, projects.trackId))
    .where(and(eq(projects.eventId, eventId), eq(projects.status, "submitted"), isNull(projects.duplicateOf)))
    .orderBy(asc(projects.id))
    .all();
  return rows.map((p) => withoutHidden(p, modes));
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
export function keptCopies(db: DbOrTx, eventId: string): Map<string, string> {
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
  /** whether open-link ballots add to the result (they are always counted apart) */
  countLink: boolean;
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
    countLink: settings.countLink,
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
  const t = takeAudited(key, limit, audit);
  if (!t.ok) throw new RateLimitedError(t.retryAfter);
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
/**
 * `held` reads the ballot cookie this browser already holds for an event, if any: the open link
 * promises one ballot per browser, so a browser that holds a ballot in the event gets it back.
 */
export function enterVoting(
  code: string,
  client: Client,
  held?: (eventId: string) => string | undefined,
): { eventSlug: string; eventId: string; token: string } {
  const db = getDb();
  const hash = sha256(code);
  const listed = db.select().from(voters).where(eq(voters.tokenHash, hash)).get();
  if (listed) {
    lookedUp(client, listed);
    const event = requireEvent(db, listed.eventId);
    return { eventSlug: event.slug, eventId: event.id, token: code };
  }
  const event = lookedUp(
    client,
    db
      .select()
      .from(events)
      .all()
      .find((e) => e.settings.voting?.linkHash === hash && votingSettings(e).modes.includes("link")),
  );
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
  // One ballot per browser: entering again resumes the ballot this browser holds (set aside or not),
  // whichever of the event's links made it. Before, every entry handed out a fresh ballot, so one
  // browser could cast several and a set-aside ballot came back as a new, counted one.
  const heldToken = held?.(event.id);
  if (heldToken && voterByToken(db, event.id, heldToken)) return { eventSlug: event.slug, eventId: event.id, token: heldToken };
  const token = newSecret(24);
  const id = newId("vtr");
  db.transaction((tx) => {
    tx.insert(voters)
      .values({
        id,
        eventId: event.id,
        kind: "link",
        tokenHash: sha256(token),
        orderSeed: ballotSeed(id),
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

/**
 * A voting code looked up from one network address. An unknown code spends one of the
 * address's tries (LIMITS.voteCodeMiss) and answers 404; a known one spends none, so a
 * venue's honest voters never use them up. With no tries left, every code from the address
 * waits (429), known or not, so guessing learns nothing until the bucket refills.
 */
function lookedUp<T>(client: Client, found: T | null | undefined): T {
  const key = `votecode-miss:${client.ip ?? "none"}`;
  if (found) {
    const p = peek(key, LIMITS.voteCodeMiss);
    if (!p.ok) throw new RateLimitedError(p.retryAfter);
    return found;
  }
  const t = takeAudited(key, LIMITS.voteCodeMiss, { userId: null, label: "anonymous", what: "voting-code lookup" });
  if (!t.ok) throw new RateLimitedError(t.retryAfter);
  throw new NotFoundError("Voting link");
}

/** What a voting link is, without using it: link previews and bots fetch URLs, so entering takes a click. */
export function describeVotingCode(code: string, client: Client): { event: { id: string; slug: string; name: string }; kind: "listed" | "link"; state: VotingState; closesAt: string | null } {
  const db = getDb();
  const hash = sha256(code);
  const listed = db.select({ eventId: voters.eventId }).from(voters).where(eq(voters.tokenHash, hash)).get();
  const event = lookedUp(
    client,
    listed
      ? requireEvent(db, listed.eventId)
      : db
          .select()
          .from(events)
          .all()
          .find((e) => e.settings.voting?.linkHash === hash && votingSettings(e).modes.includes("link")),
  );
  return { event: { id: event.id, slug: event.slug, name: event.name }, kind: listed ? "listed" : "link", state: votingState(event), closesAt: event.votingCloseAt };
}

/** The cookie that carries a voter's token for one event. */
export const voteCookieName = (eventId: string) => `vote_${eventId}`;
