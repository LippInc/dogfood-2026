import "server-only";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { DbOrTx } from "./db/client";
import { projects, users, voters, votes } from "./db/schema";

/**
 * Whether this person has a vote (not voided) for this team's project, or for a duplicate the
 * count folds into it. The community count skips a member's votes for their own team
 * (dal/voting-organizer.ts, the same person matching: the voter's account, else a listed address
 * that belongs to an account), so putting them on the team or taking them off would silently
 * change the count. No team change does that: a member's own join or leave, a captain taking a
 * member off, or an organizer's change.
 */
export function votedForTeam(tx: DbOrTx, eventId: string, userId: string, teamId: string): boolean {
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
