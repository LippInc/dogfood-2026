import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor, VoterKind } from "../authz";
import { getDb, type DbOrTx } from "../db/client";
import { events, projects, teamMembers, teams, users, voters, votes, type VoteRuleChange, type VoteRules } from "../db/schema";
import { formatUtc } from "@/lib/format";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { newId, newSecret, sha256 } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { parse, utcTimeOrEmpty } from "./parse";
import { votingSettings, anyBallotCast, type VotingState, votingState, keptCopies, type VoterRow } from "./voting";
import { shownTitle } from "./project-fields";

// The organizer's side of the community vote: the window and who may vote, the voter list and its
// links, setting a ballot aside and counting it again, and the count, live for the organizers and
// public once the window closes. The voter's side is in voting.ts.

export const SettingsInput = z
  .object({
    votingOpenAt: utcTimeOrEmpty,
    votingCloseAt: utcTimeOrEmpty,
    modes: z.array(z.enum(["account", "listed", "link"])).default([]),
    votesPerVoter: z.coerce.number().int().min(1).max(20),
    /** whether open-link ballots add to the result; left out, it stays as it is */
    countLink: z.boolean().optional(),
    /** why, when who may vote or the favourites per voter change after the first ballot; the count shows it */
    reason: z.string().trim().max(500).optional(),
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
  // Publishing ends the vote (endVoteForPublish), and a vote set up after it would run with the ranking in view.
  if (event.resultsPublishedAt)
    throw new ConflictError("results_published", "Results are published, so the community vote is over and cannot be set up or changed.");
}

export type VoteSummary = { state: VotingState; opensAt: string | null; closesAt: string | null; ballots: number };

/** Where the community vote stands, for the publish step (publishing ends it). */
export function voteSummary(db: DbOrTx, event: EventRow): VoteSummary {
  const state = votingState(event);
  const ballots =
    state === "not_set"
      ? 0
      : db
          .select({ n: sql<number>`count(distinct ${voters.id})` })
          .from(voters)
          .innerJoin(votes, eq(votes.voterId, voters.id))
          .where(and(eq(voters.eventId, event.id), isNull(voters.voidedAt)))
          .get()!.n;
  return { state, opensAt: event.votingOpenAt, closesAt: event.votingCloseAt, ballots };
}

/**
 * Publishing ends the community vote, so nobody votes with the judged ranking in view (the
 * organizers' rule: results hidden from everyone but organizers during the voting window). An
 * open vote closes at the publishing moment, its count final and public with the results; a
 * vote that has not opened yet is called off. Runs inside the publish transaction and returns
 * what changed for its audit row, or null when there was no vote to end.
 */
export function endVoteForPublish(tx: DbOrTx, event: EventRow, at: string) {
  const state = votingState(event, Date.parse(at));
  if (state !== "open" && state !== "upcoming") return null;
  const window = state === "open" ? { votingOpenAt: event.votingOpenAt, votingCloseAt: at } : { votingOpenAt: null, votingCloseAt: null };
  tx.update(events).set(window).where(eq(events.id, event.id)).run();
  return { ended: state, before: { votingOpenAt: event.votingOpenAt, votingCloseAt: event.votingCloseAt }, after: window };
}

const sameRules = (a: VoteRules, b: VoteRules) => a.votesPerVoter === b.votesPerVoter && [...a.modes].sort().join() === [...b.modes].sort().join();

/**
 * The counting rules hold from the first ballot on. Whether open-link ballots count is fixed outright
 * (above); who may vote and how many favourites each can still change, to fix a mistake, but only with
 * a written reason: some ballots were cast under the old rules, so the change is audited with its reason,
 * kept on the event and shown with the count, public and the organizers' (like a rubric weight changed
 * after the first score). Returns the change to keep, or null when the rules stay or no ballot is in yet.
 * The window is not a counting rule here: moving it is the window's own business.
 */
function countingRulesHold(tx: DbOrTx, event: EventRow, current: VoteRules, next: VoteRules, reason: string): VoteRuleChange | null {
  if (sameRules(current, next) || !anyBallotCast(tx, event.id)) return null;
  if (reason.length < 3) {
    throw new ValidationError("Ballots are already in, so changing who may vote or the favourites per voter needs a reason: the count will show it.", {
      reason: ["say why the rules change, in a few words"],
    });
  }
  const rules = (r: VoteRules): VoteRules => ({ modes: [...r.modes].sort(), votesPerVoter: r.votesPerVoter });
  return { at: new Date().toISOString(), reason, before: rules(current), after: rules(next) };
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
    // Deciding whether open-link ballots count after seeing them would let an organizer pick
    // the outcome, so the rule is fixed from the first ballot on.
    const current = votingSettings(event);
    const countLink = input.countLink ?? current.countLink;
    if (countLink !== current.countLink && anyBallotCast(tx, event.id)) {
      throw new ConflictError(
        "count_rule_fixed",
        `Ballots are already in, so whether open-link ballots count is fixed: they ${current.countLink ? "count" : "are counted apart and do not add to the result"}.`,
      );
    }
    const before = { votingOpenAt: event.votingOpenAt, votingCloseAt: event.votingCloseAt, ...current, linkHash: undefined };
    const voting = { ...current, modes: [...new Set(input.modes)].sort() as VoterKind[], votesPerVoter: input.votesPerVoter, countLink };
    const ruleChange = countingRulesHold(tx, event, current, voting, input.reason ?? "");
    const voteRuleChanges = ruleChange ? [...(event.settings.voteRuleChanges ?? []), ruleChange] : event.settings.voteRuleChanges;
    tx.update(events)
      .set({
        votingOpenAt: input.votingOpenAt || null,
        votingCloseAt: input.votingCloseAt || null,
        settings: { ...event.settings, voting, ...(voteRuleChanges ? { voteRuleChanges } : {}) },
      })
      .where(eq(events.id, event.id))
      .run();
    const after = { votingOpenAt: input.votingOpenAt || null, votingCloseAt: input.votingCloseAt || null, modes: voting.modes, votesPerVoter: voting.votesPerVoter, countLink };
    return {
      result: { ok: true, rulesChanged: ruleChange !== null },
      audit: ruleChange
        ? { action: "voting.rules_changed", eventId: event.id, targetType: "event", targetId: event.id, before, after: { ...after, reason: ruleChange.reason } }
        : { action: "voting.settings", eventId: event.id, targetType: "event", targetId: event.id, before, after },
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

export const VoterAddress = z.object({ email: z.string().trim().toLowerCase().pipe(z.email("not an email address")) });

/**
 * A fresh personal link for one address already on the voter list, when its link was mistyped, bounced
 * or lost: the old link stops working at once, and the new one is returned this once. A ballot set aside
 * stays set aside, so its voter gets no new link until it is counted again.
 */
export function newVoterLink(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  return organizer(actor, eventIdOrSlug, (tx, event) => {
    voteFinal(event);
    const { email } = parse(VoterAddress, body);
    const v = tx
      .select({ id: voters.id, voidedAt: voters.voidedAt })
      .from(voters)
      .where(and(eq(voters.eventId, event.id), eq(voters.kind, "listed"), eq(voters.email, email)))
      .get();
    if (!v) throw new NotFoundError("An address on the voter list like this");
    if (v.voidedAt) throw new ConflictError("voter_set_aside", `The ballot of ${email} is set aside: count it again before making a new link.`);
    const token = newSecret(24);
    tx.update(voters).set({ tokenHash: sha256(token) }).where(eq(voters.id, v.id)).run();
    return {
      result: { email, path: `/vote/${token}` },
      audit: { action: "voter.new_link", eventId: event.id, targetType: "voter", targetId: v.id },
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

/**
 * votes: what counts toward the result; openLink: the open link's votes for the project,
 * counted or not; place: from `votes`, shared by equal counts (1, 1, 3), and null for a
 * project with no counted vote, which has no place.
 */
export type Tally = { projectId: string; title: string; teamName: string; votes: number; openLink: number; place: number | null };

/**
 * Counted votes per project. Voided voters are left out; a vote on a merged copy counts
 * for the copy it was merged into, once per voter; and a vote a known person gave a
 * project whose team they are on (they joined it after voting) does not count. Open-link
 * votes are kept in their own column and add to `votes` only when the organizer counts them.
 * DAL-internal; callers decide who may see it.
 */
function tally(db: DbOrTx, event: EventRow): Tally[] {
  const eventId = event.id;
  const { countLink } = votingSettings(event);
  const kept = keptCopies(db, eventId);
  const rows = db
    .select({ id: projects.id, title: shownTitle(), teamId: projects.teamId, teamName: teams.name })
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
  const fromLink = new Map<string, Set<string>>(); // the same, for open-link voters
  for (const v of db
    .select({ voterId: votes.voterId, projectId: votes.projectId, kind: voters.kind, userId: voters.userId, email: voters.email })
    .from(votes)
    .innerJoin(voters, eq(voters.id, votes.voterId))
    .where(and(eq(voters.eventId, eventId), isNull(voters.voidedAt)))
    .all()) {
    const project = kept.get(v.projectId);
    if (!project || !teamOf.has(project)) continue;
    const person = v.userId ?? (v.email ? byEmail.get(v.email) : undefined);
    if (person && teamsOf.get(person)?.has(teamOf.get(project)!)) continue;
    const into = v.kind === "link" ? fromLink : counted;
    into.set(project, (into.get(project) ?? new Set()).add(v.voterId));
  }
  const list = rows
    .map((r) => {
      const link = fromLink.get(r.id)?.size ?? 0;
      return { projectId: r.id, title: r.title, teamName: r.teamName, n: (counted.get(r.id)?.size ?? 0) + (countLink ? link : 0), link };
    })
    .sort((a, b) => b.n - a.n || a.title.localeCompare(b.title));
  return list.map((r) => ({
    projectId: r.projectId,
    title: r.title,
    teamName: r.teamName,
    votes: r.n,
    openLink: r.link,
    place: r.n > 0 ? list.findIndex((x) => x.n === r.n) + 1 : null,
  }));
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
    settings: {
      modes: settings.modes,
      votesPerVoter: settings.votesPerVoter,
      linkActive: Boolean(settings.linkHash),
      countLink: settings.countLink,
      /** the counting rule is fixed from the first ballot on; from then on the other rules change only with a reason */
      countRuleFixed: anyBallotCast(db, event.id),
      ruleChanges: event.settings.voteRuleChanges ?? [],
    },
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
    tally: state === "open" || state === "closed" ? tally(db, event) : null,
  };
}

/**
 * countLink: whether the open link's votes add to `votes` (each row shows them apart either way);
 * ruleChanges: changes to who may vote or the favourites per voter made after the first ballot, with their reasons
 */
export type CommunityResults = { state: VotingState; closesAt: string | null; countLink: boolean; ruleChanges: VoteRuleChange[]; tally: Tally[] | null };

/** The public community vote: only after the window closes (organizers see it live in getVotingAdmin). */
export function getCommunityResults(eventIdOrSlug: string): CommunityResults {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  const state = votingState(event);
  return {
    state,
    closesAt: event.votingCloseAt,
    countLink: votingSettings(event).countLink,
    ruleChanges: event.settings.voteRuleChanges ?? [],
    tally: state === "closed" ? tally(db, event) : null,
  };
}
