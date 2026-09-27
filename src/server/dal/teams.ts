import "server-only";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { getDb, type DbOrTx, type Tx } from "../db/client";
import { assignments, events, projects, teamMembers, teams, userRoles, users } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { mutate } from "../mutate";
import { newId, newSecret } from "../util";
import { eventFacts, requireEvent, type EventRow } from "./events";
import { issuesOf } from "./parse";

// Teams form by invite link: a signed-in person creates a team (and becomes its
// captain), the captain shares /join/<code>, anyone signed in who is not yet on a
// team in that event joins with one click. Only while submissions are open.

const DEFAULT_MAX_TEAM_SIZE = 4;

export const TeamName = z.object({ name: z.string().trim().min(1, "a team name is required").max(60) });

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
      const parsed = TeamName.safeParse(body);
      if (!parsed.success) throw new ValidationError("The team is not valid.", issuesOf(parsed.error));
      const now = new Date().toISOString();
      const team = { id: newId("tm"), eventId: event.id, name: parsed.data.name, inviteCode: newSecret(12), createdAt: now };
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
      const t = tx.select({ id: teams.id, eventId: teams.eventId }).from(teams).where(eq(teams.id, teamId)).get();
      if (!t) throw new NotFoundError("Team");
      team = t;
      const membership = actor
        ? tx
            .select({ role: teamMembers.role })
            .from(teamMembers)
            .where(and(eq(teamMembers.teamId, t.id), eq(teamMembers.userId, actor.userId)))
            .get()
        : undefined;
      return {
        kind: "team",
        event: eventFacts(requireEvent(tx, t.eventId)),
        isMember: Boolean(membership),
        isCaptain: membership?.role === "captain",
      };
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

export type MyTeam = {
  id: string;
  name: string;
  role: "captain" | "member";
  inviteCode: string | null;
  members: { name: string; role: "captain" | "member" }[];
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
    .select({ name: users.name, role: teamMembers.role })
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
