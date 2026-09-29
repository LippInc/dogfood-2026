import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { runsEvent, submissionsOpen, type Actor } from "../authz";
import { getDb, type DbOrTx, type Tx } from "../db/client";
import {
  assignments,
  auditLog,
  comments,
  comparisons,
  customAnswers,
  events,
  normalizedScores,
  projects,
  teamMembers,
  teams,
  userRoles,
  users,
  voters,
  votes,
} from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { DEFAULT_MAX_TEAM_SIZE } from "../project-limits";
import { discardUpload } from "../uploads";
import { newId, newSecret } from "../util";
import { auditOfTarget, type AuditLine } from "./audit-log";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { parse } from "./parse";

// Teams form by invite link: a signed-in person creates a team (and becomes its
// captain), the captain shares /join/<code>, anyone signed in who is not yet on a
// team in that event joins with one click. Only while submissions are open.


export const TeamName = z.object({ name: z.string().trim().min(1, "a team name is required").max(60) });

/** An event of one person per team: nobody forms a team, so nobody should have to name one. */
export const isSolo = (e: Pick<EventRow, "settings">) => (e.settings.maxTeamSize ?? DEFAULT_MAX_TEAM_SIZE) === 1;

/** The body with the person's own name as the team's, when the event is one person per team and no name was given. */
function nameOrOwn(body: unknown, event: EventRow, actor: Actor): unknown {
  const given = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
  if (!isSolo(event) || (typeof given === "string" && given.trim() !== "")) return body;
  return { ...(body && typeof body === "object" ? body : {}), name: actor.name.trim().slice(0, 60) };
}

function onTeamIn(tx: DbOrTx, userId: string, eventId: string): boolean {
  return Boolean(
    tx
      .select({ t: teamMembers.teamId })
      .from(teamMembers)
      .where(and(eq(teamMembers.userId, userId), eq(teamMembers.eventId, eventId)))
      .get(),
  );
}

/** The judge holds a live (not recused) assignment on this team's project. */
function assignedToTeam(tx: DbOrTx, userId: string, teamId: string): boolean {
  return Boolean(
    tx
      .select({ a: assignments.id })
      .from(assignments)
      .innerJoin(projects, eq(projects.id, assignments.projectId))
      .where(and(eq(projects.teamId, teamId), eq(assignments.judgeUserId, userId), ne(assignments.status, "recused")))
      .get(),
  );
}

/**
 * Whether this person has a vote (not voided) for this team's project, or for a duplicate the
 * count folds into it. The community count skips a member's votes for their own team
 * (voting-organizer.ts, the same person matching: the voter's account, else a listed address
 * that belongs to an account), so putting them on the team or taking them off would silently
 * change the count. No team change does that: a member's own join or leave, a captain taking a
 * member off, or an organizer's change.
 */
function votedForTeam(tx: DbOrTx, eventId: string, userId: string, teamId: string): boolean {
  const own = tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.eventId, eventId), eq(projects.teamId, teamId)))
    .all()
    .map((p) => p.id);
  if (own.length === 0) return false;
  const folded = tx.select({ id: projects.id }).from(projects).where(inArray(projects.duplicateOf, own)).all().map((p) => p.id);
  const email = tx.select({ email: users.email }).from(users).where(eq(users.id, userId)).get()?.email;
  const who = email ? or(eq(voters.userId, userId), and(isNull(voters.userId), eq(voters.email, email))) : eq(voters.userId, userId);
  return Boolean(
    tx
      .select({ v: votes.voterId })
      .from(votes)
      .innerJoin(voters, eq(voters.id, votes.voterId))
      .where(and(eq(voters.eventId, eventId), isNull(voters.voidedAt), inArray(votes.projectId, [...own, ...folded]), who))
      .get(),
  );
}

function addParticipantRole(tx: Tx, userId: string, eventId: string, now: string) {
  tx.insert(userRoles).values({ userId, eventId, role: "participant", createdAt: now }).onConflictDoNothing().run();
}

export function createTeam(actor: Actor | null, eventIdOrSlug: string, body: unknown) {
  let event: EventRow;
  return mutate({
    actor,
    action: "team.create",
    load: (tx) => {
      event = requireEvent(tx, eventIdOrSlug);
      return { kind: "team_work", event: eventFacts(event), onTeam: actor ? onTeamIn(tx, actor.userId, event.id) : false };
    },
    run: (tx) => {
      const { name } = parse(TeamName, nameOrOwn(body, event, actor!), "The team is not valid.");
      const now = new Date().toISOString();
      const team = { id: newId("tm"), eventId: event.id, name, inviteCode: newSecret(12), createdAt: now };
      tx.insert(teams).values(team).run();
      tx.insert(teamMembers).values({ eventId: event.id, teamId: team.id, userId: actor!.userId, role: "captain", joinedAt: now }).run();
      addParticipantRole(tx, actor!.userId, event.id, now);
      return {
        result: team,
        audit: { eventId: event.id, targetType: "team", targetId: team.id, after: { name: team.name } },
      };
    },
  });
}

export type InviteView = { teamId: string; teamName: string; members: number; maxSize: number; event: { id: string; slug: string; name: string } };

/** What the invite link shows before joining. Public: the code itself is the capability. */
export function inviteByCode(code: string): InviteView {
  const db = getDb();
  const row = db
    .select({ teamId: teams.id, teamName: teams.name, eventId: events.id, slug: events.slug, eventName: events.name, settings: events.settings })
    .from(teams)
    .innerJoin(events, eq(events.id, teams.eventId))
    .where(eq(teams.inviteCode, code))
    .get();
  if (!row) throw new NotFoundError("Invite link");
  const members = db.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, row.teamId)).get()?.n ?? 0;
  return {
    teamId: row.teamId,
    teamName: row.teamName,
    members,
    maxSize: row.settings.maxTeamSize ?? DEFAULT_MAX_TEAM_SIZE,
    event: { id: row.eventId, slug: row.slug, name: row.eventName },
  };
}

export function joinTeam(actor: Actor | null, code: string) {
  let team: { id: string; name: string; eventId: string };
  let event: EventRow;
  return mutate({
    actor,
    action: "team.join",
    load: (tx) => {
      const t = tx.select({ id: teams.id, name: teams.name, eventId: teams.eventId }).from(teams).where(eq(teams.inviteCode, code)).get();
      if (!t) throw new NotFoundError("Invite link");
      team = t;
      event = requireEvent(tx, t.eventId);
      return {
        kind: "team_work",
        event: eventFacts(event),
        onTeam: actor ? onTeamIn(tx, actor.userId, t.eventId) : false,
        assignedToTeam: actor ? assignedToTeam(tx, actor.userId, t.id) : false,
      };
    },
    run: (tx) => {
      if (votedForTeam(tx, team.eventId, actor!.userId, team.id)) {
        throw new ConflictError(
          "vote_would_change",
          `You have a community vote for ${team.name}'s project, and votes for your own team do not count: joining would take that vote out of the count. Take that pick off your ballot first while voting is open, or ask an organizer to void your vote (it is audited), then join.`,
        );
      }
      const size = tx.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).get()?.n ?? 0;
      const max = event.settings.maxTeamSize ?? DEFAULT_MAX_TEAM_SIZE;
      if (size >= max) throw new ConflictError("team_full", `${team.name} already has ${size} members, the most this event allows.`);
      const now = new Date().toISOString();
      tx.insert(teamMembers).values({ eventId: team.eventId, teamId: team.id, userId: actor!.userId, role: "member", joinedAt: now }).run();
      addParticipantRole(tx, actor!.userId, team.eventId, now);
      return {
        result: { teamId: team.id, eventSlug: event.slug },
        audit: { eventId: team.eventId, targetType: "team", targetId: team.id, after: { joined: actor!.userId } },
      };
    },
  });
}

/** The captain replaces the invite code; every older link stops working. */
export function rotateInvite(actor: Actor | null, teamId: string) {
  let team: { id: string; eventId: string };
  return mutate({
    actor,
    action: "team.manage",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      return loaded.resource;
    },
    run: (tx) => {
      const inviteCode = newSecret(12);
      tx.update(teams).set({ inviteCode }).where(eq(teams.id, team.id)).run();
      return {
        result: { inviteCode },
        audit: { action: "team.invite_rotated", eventId: team.eventId, targetType: "team", targetId: team.id },
      };
    },
  });
}

/** The team, its event and the actor's place on it, for a team action's permission check. */
function loadTeam(tx: DbOrTx, actor: Actor | null, teamId: string) {
  const team = tx.select({ id: teams.id, name: teams.name, eventId: teams.eventId }).from(teams).where(eq(teams.id, teamId)).get();
  if (!team) throw new NotFoundError("Team");
  const membership = actor
    ? tx.select({ role: teamMembers.role }).from(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, actor.userId))).get()
    : undefined;
  const resource = {
    kind: "team" as const,
    event: eventFacts(requireEvent(tx, team.eventId)),
    isMember: Boolean(membership),
    isCaptain: membership?.role === "captain",
  };
  return { team, resource };
}

const memberOf = (tx: DbOrTx, teamId: string, userId: string) =>
  tx
    .select({ userId: teamMembers.userId, role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();

/**
 * A member leaves the team (their participant role stays, so they can join another). The
 * captain hands the captaincy over first, and the last member cannot leave, so a team and
 * its project are never left with nobody: they dissolve the team instead (dissolveTeam).
 */
export function leaveTeam(actor: Actor | null, teamId: string) {
  let team: { id: string; eventId: string };
  return mutate({
    actor,
    action: "team.leave",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      return loaded.resource;
    },
    run: (tx) => {
      const me = memberOf(tx, team.id, actor!.userId)!;
      const size = tx.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).get()!.n;
      if (size === 1) {
        throw new ConflictError(
          "last_member",
          "You are the team's only member, so leaving would leave it with nobody. Dissolve the team instead (a draft project goes with it).",
        );
      }
      if (me.role === "captain") throw new ConflictError("captain_hands_over_first", "Make another member captain first, then leave.");
      if (votedForTeam(tx, team.eventId, actor!.userId, team.id)) {
        throw new ConflictError(
          "vote_would_change",
          "You have a community vote for your own team's project, which is not counted while you are on the team: leaving would start counting it. Take that pick off your ballot first while voting is open, or ask an organizer to void your vote (it is audited), then leave.",
        );
      }
      tx.delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, actor!.userId))).run();
      return {
        result: { teamId: team.id },
        audit: { action: "team.left", eventId: team.eventId, targetType: "team", targetId: team.id, before: { member: actor!.userId } },
      };
    },
  });
}

/**
 * The team's only member dissolves it, while submissions are open: someone who started a team by
 * mistake can then join the one they meant to. A submitted project keeps its team (it is in the
 * gallery and may be judged), so only a team with no project or a draft can go; the draft goes with
 * it, answers and uploaded picture included, and the audit row keeps its id and title.
 */
export function dissolveTeam(actor: Actor | null, teamId: string) {
  let team: { id: string; name: string; eventId: string };
  let picture: string | null = null;
  const result = mutate({
    actor,
    action: "team.dissolve",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      return loaded.resource;
    },
    run: (tx) => {
      const size = tx.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).get()!.n;
      if (size > 1) {
        throw new ConflictError("others_on_the_team", "Others are still on this team. Only its last member can dissolve it; to go, leave it instead.");
      }
      const project = tx
        .select({ id: projects.id, title: projects.title, status: projects.status, thumbnailUrl: projects.thumbnailUrl })
        .from(projects)
        .where(eq(projects.teamId, team.id))
        .get();
      if (project?.status === "submitted") {
        throw new ConflictError(
          "project_submitted",
          "This team's project is submitted, so the team stays with it. If it was a mistake, ask the organizers.",
        );
      }
      if (project) {
        // A draft has no reviews, votes or comments; if anything points at it after all, keep everything.
        const used = [
          tx.select({ x: assignments.id }).from(assignments).where(eq(assignments.projectId, project.id)).get(),
          tx.select({ x: comments.id }).from(comments).where(eq(comments.projectId, project.id)).get(),
          tx.select({ x: votes.voterId }).from(votes).where(eq(votes.projectId, project.id)).get(),
          tx.select({ x: normalizedScores.projectId }).from(normalizedScores).where(eq(normalizedScores.projectId, project.id)).get(),
          tx
            .select({ x: comparisons.id })
            .from(comparisons)
            .where(or(eq(comparisons.leftProjectId, project.id), eq(comparisons.rightProjectId, project.id)))
            .get(),
          tx.select({ x: projects.id }).from(projects).where(eq(projects.duplicateOf, project.id)).get(),
        ].some(Boolean);
        if (used) throw new ConflictError("project_in_use", "This team's draft is already part of the judging, so the team stays. Ask the organizers.");
        tx.delete(customAnswers).where(eq(customAnswers.projectId, project.id)).run();
        tx.delete(projects).where(eq(projects.id, project.id)).run();
        // the file goes after the commit, and only if no other project shows it
        const shared = project.thumbnailUrl
          ? tx.select({ id: projects.id }).from(projects).where(eq(projects.thumbnailUrl, project.thumbnailUrl)).get()
          : undefined;
        picture = shared ? null : project.thumbnailUrl;
      }
      tx.delete(teamMembers).where(eq(teamMembers.teamId, team.id)).run();
      tx.delete(teams).where(eq(teams.id, team.id)).run();
      return {
        result: { teamId: team.id, draftDeleted: project?.id ?? null },
        audit: {
          action: "team.dissolved",
          eventId: team.eventId,
          targetType: "team",
          targetId: team.id,
          before: { name: team.name, member: actor!.userId, draft: project ? { id: project.id, title: project.title } : null },
        },
      };
    },
  });
  discardUpload(picture);
  return result;
}

/** The captain takes a member off the team (to leave themselves, they hand the captaincy over and leave). */
export function removeMember(actor: Actor | null, teamId: string, userId: string) {
  let team: { id: string; eventId: string };
  return mutate({
    actor,
    action: "team.members",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      return loaded.resource;
    },
    run: (tx) => {
      if (userId === actor!.userId) throw new ConflictError("cannot_remove_yourself", "To leave, make another member captain first, then leave.");
      if (!memberOf(tx, team.id, userId)) throw new NotFoundError("Team member");
      if (votedForTeam(tx, team.eventId, userId, team.id)) {
        throw new ConflictError(
          "vote_would_change",
          "This member has a community vote for your team's project, which is not counted while they are on the team: taking them off would start counting it. They can take that pick off their ballot while voting is open, or an organizer can void the vote (it is audited).",
        );
      }
      tx.delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId))).run();
      return {
        result: { teamId: team.id, removed: userId },
        audit: { action: "team.member_removed", eventId: team.eventId, targetType: "team", targetId: team.id, before: { member: userId } },
      };
    },
  });
}

export const CaptainInput = z.object({ userId: z.string().min(1) });

/** The captain hands the captaincy to another member and becomes a member. */
export function makeCaptain(actor: Actor | null, teamId: string, body: unknown) {
  let team: { id: string; eventId: string };
  return mutate({
    actor,
    action: "team.members",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      return loaded.resource;
    },
    run: (tx) => {
      const next = parse(CaptainInput, body, "Name the member who becomes captain.").userId;
      if (next === actor!.userId) throw new ConflictError("already_captain", "You are this team's captain already.");
      if (!memberOf(tx, team.id, next)) throw new NotFoundError("Team member");
      tx.update(teamMembers).set({ role: "member" }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, actor!.userId))).run();
      tx.update(teamMembers).set({ role: "captain" }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, next))).run();
      return {
        result: { teamId: team.id, captain: next },
        audit: {
          action: "team.captain_changed",
          eventId: team.eventId,
          targetType: "team",
          targetId: team.id,
          before: { captain: actor!.userId },
          after: { captain: next },
        },
      };
    },
  });
}

/** A reason for an organizer's change to a team, kept in the audit log. */
export const TeamChangeReason = z.string().trim().min(3, "say why, in a few words").max(300);
export const RenameInput = z.object({ name: TeamName.shape.name, reason: z.string().trim().max(300).optional() });
const OrganizerRenameInput = z.object({ name: TeamName.shape.name, reason: TeamChangeReason });

/**
 * Rename a team. Its members do, while submissions are open (team.renamed). Anyone else allowed
 * (an organizer: after the close, or on a team they are not on) gives a reason, and the row says
 * the organizers did it (team.renamed_by_organizer). Until results are published (authorize).
 */
export function renameTeam(actor: Actor | null, teamId: string, body: unknown) {
  let team: { id: string; name: string; eventId: string };
  let asMember = false;
  const now = new Date();
  return mutate({
    actor,
    action: "team.rename",
    now,
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      asMember = loaded.resource.isMember && submissionsOpen(loaded.resource.event, now);
      return loaded.resource;
    },
    run: (tx) => {
      const { name, reason } = asMember ? parse(RenameInput, body) : parse(OrganizerRenameInput, body);
      if (name === team.name) return { result: { teamId: team.id, name }, audit: null };
      tx.update(teams).set({ name }).where(eq(teams.id, team.id)).run();
      return {
        result: { teamId: team.id, name },
        audit: {
          action: asMember ? "team.renamed" : "team.renamed_by_organizer",
          eventId: team.eventId,
          targetType: "team",
          targetId: team.id,
          before: { name: team.name },
          after: asMember ? { name } : { name, reason },
        },
      };
    },
  });
}

export const AddMemberInput = z.object({ email: z.string().trim().toLowerCase().email("an email address such as ada@example.org"), reason: TeamChangeReason });
export const RemoveMemberInput = z.object({ reason: TeamChangeReason });

/**
 * An organizer puts someone on a team, with a reason, until results are published: a person
 * left off by mistake gets their place (and their certificate) back after the close. The
 * rules a join follows still hold: one team per person per event, the event's team size, and
 * no judge assigned to the team's project.
 */
export function organizerAddMember(actor: Actor | null, teamId: string, body: unknown) {
  let team: { id: string; name: string; eventId: string };
  let event: EventRow;
  return mutate({
    actor,
    action: "team.organize",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      event = requireEvent(tx, team.eventId);
      return loaded.resource;
    },
    run: (tx) => {
      const { email, reason } = parse(AddMemberInput, body);
      const person = tx.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email)).get();
      if (!person) {
        throw new ValidationError("No account has that address: they sign up first, then you add them.", { email: ["no account has that address"] });
      }
      const current = tx
        .select({ teamId: teamMembers.teamId, name: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(and(eq(teamMembers.userId, person.id), eq(teamMembers.eventId, team.eventId)))
        .get();
      if (current?.teamId === team.id) throw new ConflictError("already_on_this_team", `${person.name} is on ${team.name} already.`);
      if (current) {
        throw new ConflictError("already_on_a_team", `${person.name} is on ${current.name} in this event: one person, one team. Take them off it first.`);
      }
      if (assignedToTeam(tx, person.id, team.id)) {
        throw new ConflictError("conflict_of_interest", `${person.name} is assigned to judge this team's project. Reassign that review first.`);
      }
      if (votedForTeam(tx, team.eventId, person.id, team.id)) {
        throw new ConflictError(
          "vote_would_change",
          `${person.name} has a community vote for this team's project, and votes for your own team do not count: adding them would take that vote out of the count. Void their vote on the Voting page first (it is audited), then add them.`,
        );
      }
      const size = tx.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).get()?.n ?? 0;
      const max = event.settings.maxTeamSize ?? DEFAULT_MAX_TEAM_SIZE;
      if (size >= max) throw new ConflictError("team_full", `${team.name} already has ${size} members, the most this event allows (Settings).`);
      const now = new Date().toISOString();
      tx.insert(teamMembers).values({ eventId: team.eventId, teamId: team.id, userId: person.id, role: "member", joinedAt: now }).run();
      addParticipantRole(tx, person.id, team.eventId, now);
      return {
        result: { teamId: team.id, added: person.id },
        audit: { action: "team.member_added_by_organizer", eventId: team.eventId, targetType: "team", targetId: team.id, after: { member: person.id, reason } },
      };
    },
  });
}

/**
 * An organizer takes someone off a team, with a reason, until results are published. The last
 * member stays (a team is never left with nobody); a captain taken off hands the captaincy to
 * the member who joined first.
 */
export function organizerRemoveMember(actor: Actor | null, teamId: string, userId: string, body: unknown) {
  let team: { id: string; name: string; eventId: string };
  return mutate({
    actor,
    action: "team.organize",
    load: (tx) => {
      const loaded = loadTeam(tx, actor, teamId);
      team = loaded.team;
      return loaded.resource;
    },
    run: (tx) => {
      const { reason } = parse(RemoveMemberInput, body);
      const leaving = memberOf(tx, team.id, userId);
      if (!leaving) throw new NotFoundError("Team member");
      const size = tx.select({ n: sql<number>`count(*)` }).from(teamMembers).where(eq(teamMembers.teamId, team.id)).get()!.n;
      if (size === 1) throw new ConflictError("last_member", "That is the team's only member, and a team is never left with nobody.");
      if (votedForTeam(tx, team.eventId, userId, team.id)) {
        throw new ConflictError(
          "vote_would_change",
          "This member has a community vote for their own team's project, which is not counted while they are on the team: taking them off would start counting it. Void their vote on the Voting page first (it is audited), or leave them on.",
        );
      }
      tx.delete(teamMembers).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, userId))).run();
      let captain: string | null = null;
      if (leaving.role === "captain") {
        captain = tx
          .select({ userId: teamMembers.userId })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, team.id))
          .orderBy(asc(teamMembers.joinedAt), asc(teamMembers.userId))
          .get()!.userId;
        tx.update(teamMembers).set({ role: "captain" }).where(and(eq(teamMembers.teamId, team.id), eq(teamMembers.userId, captain))).run();
      }
      return {
        result: { teamId: team.id, removed: userId, captain },
        audit: {
          action: "team.member_removed_by_organizer",
          eventId: team.eventId,
          targetType: "team",
          targetId: team.id,
          before: { member: userId, role: leaving.role },
          after: captain ? { reason, captain } : { reason },
        },
      };
    },
  });
}

/** What an organizer does to a team that the team did not do itself. */
export const ORGANIZER_TEAM_ACTIONS = ["team.renamed_by_organizer", "team.member_added_by_organizer", "team.member_removed_by_organizer"];

/** When the organizers last changed this team after submissions closed (the team the judges saw), or null. */
export function organizerChangedAfterClose(db: DbOrTx, event: { id: string; submissionsCloseAt: string }, teamId: string): string | null {
  return (
    db
      .select({ at: auditLog.at })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventId, event.id),
          eq(auditLog.targetType, "team"),
          eq(auditLog.targetId, teamId),
          inArray(auditLog.action, ORGANIZER_TEAM_ACTIONS),
          gte(auditLog.at, new Date(event.submissionsCloseAt).toISOString()),
        ),
      )
      .orderBy(desc(auditLog.id))
      .get()?.at ?? null
  );
}

/**
 * Every team of the event the organizers changed after submissions closed, as project id -> the
 * team id and the last such change's time: one query for the whole event, for the results pages.
 */
export function organizerChangesAfterCloseByProject(
  db: DbOrTx,
  event: { id: string; submissionsCloseAt: string },
): Map<string, { teamId: string; at: string }> {
  const rows = db
    .select({ projectId: projects.id, teamId: projects.teamId, at: sql<string>`max(${auditLog.at})` })
    .from(auditLog)
    .innerJoin(projects, and(eq(projects.teamId, auditLog.targetId), eq(projects.eventId, auditLog.eventId)))
    .where(
      and(
        eq(auditLog.eventId, event.id),
        eq(auditLog.targetType, "team"),
        inArray(auditLog.action, ORGANIZER_TEAM_ACTIONS),
        gte(auditLog.at, new Date(event.submissionsCloseAt).toISOString()),
      ),
    )
    .groupBy(projects.id)
    .all();
  return new Map(rows.map((r) => [r.projectId, { teamId: r.teamId, at: r.at }]));
}

/** The same, for the organizers' results page: only the event's organizers (and an administrator) read it. */
export function getTeamChangesAfterClose(actor: Actor | null, eventIdOrSlug: string): Map<string, { teamId: string; at: string }> {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return organizerChangesAfterCloseByProject(db, event);
}

export type OrganizerTeamView = {
  event: { id: string; slug: string; name: string; submissionsCloseAt: string; resultsPublishedAt: string | null };
  team: { id: string; name: string; createdAt: string };
  members: { userId: string; name: string; email: string; role: "captain" | "member"; joinedAt: string }[];
  project: { id: string; title: string; status: "draft" | "submitted" } | null;
  /** while results are unpublished an organizer of this event may change the team (an administrator only reads) */
  canChange: boolean;
  history: AuditLine[];
};

/** One team as its event's organizers see it: members with their addresses, its project and what happened to it. */
export function getTeamForOrganizer(actor: Actor | null, eventIdOrSlug: string, teamId: string): OrganizerTeamView {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  const team = db
    .select({ id: teams.id, name: teams.name, createdAt: teams.createdAt })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.eventId, event.id)))
    .get();
  if (!team) throw new NotFoundError("Team");
  const members = db
    .select({ userId: users.id, name: users.name, email: users.email, role: teamMembers.role, joinedAt: teamMembers.joinedAt })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, team.id))
    .orderBy(sql`${teamMembers.role} = 'member'`, asc(teamMembers.joinedAt))
    .all();
  const project = db.select({ id: projects.id, title: projects.title, status: projects.status }).from(projects).where(eq(projects.teamId, team.id)).get() ?? null;
  return {
    event: { id: event.id, slug: event.slug, name: event.name, submissionsCloseAt: event.submissionsCloseAt, resultsPublishedAt: event.resultsPublishedAt },
    team,
    members,
    project,
    canChange: Boolean(actor && runsEvent(actor, event.id) && !event.resultsPublishedAt),
    history: auditOfTarget(db, event.id, "team", team.id),
  };
}

export type MyTeam = {
  id: string;
  name: string;
  role: "captain" | "member";
  inviteCode: string | null;
  members: { userId: string; name: string; role: "captain" | "member" }[];
  projectId: string | null;
};

/** The actor's team in one event, or null. The invite code is shown to its captain only. */
export function myTeam(db: DbOrTx, actor: Actor, eventId: string): MyTeam | null {
  const mine = db
    .select({ id: teams.id, name: teams.name, role: teamMembers.role, inviteCode: teams.inviteCode })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.userId, actor.userId), eq(teamMembers.eventId, eventId)))
    .get();
  if (!mine) return null;
  const members = db
    .select({ userId: users.id, name: users.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, mine.id))
    .orderBy(sql`${teamMembers.role} = 'member'`, asc(teamMembers.joinedAt))
    .all();
  const project = db.select({ id: projects.id }).from(projects).where(eq(projects.teamId, mine.id)).get();
  return {
    id: mine.id,
    name: mine.name,
    role: mine.role,
    inviteCode: mine.role === "captain" ? mine.inviteCode : null,
    members,
    projectId: project?.id ?? null,
  };
}
