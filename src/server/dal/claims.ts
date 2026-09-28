import "server-only";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { appendAudit } from "../audit";
import { getDb, type DbOrTx } from "../db/client";
import { accountClaims, events, teamMembers, userRoles, users } from "../db/schema";
import { HttpError, NotFoundError, ValidationError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { createLoginSession, hashPassword, setSessionCookie } from "../session";
import { newSecret, nowIso, sha256 } from "../util";
import { eventFacts, requireEvent } from "./events";
import { parse } from "./parse";

// Personal links for people who have an account but no password: everyone who came
// in through an import (fixtures, or an event file). The organizer gets each link
// once and sends it (with email on, the portal mails it too: mailing.ts); opening
// it lets that one person set a password. A link lasts 14 days and works once; a new one replaces it.

export const CLAIM_DAYS = 14;

export const ClaimInput = z.object({
  password: z.string().min(10, "at least 10 characters").max(200),
  name: z.string().trim().min(1).max(80).optional(),
});

/** People in the event (team members, judges, organizers) who cannot sign in yet. */
function passwordless(db: DbOrTx, eventId: string) {
  const ids = new Set([
    ...db.select({ id: teamMembers.userId }).from(teamMembers).where(eq(teamMembers.eventId, eventId)).all().map((r) => r.id),
    ...db.select({ id: userRoles.userId }).from(userRoles).where(eq(userRoles.eventId, eventId)).all().map((r) => r.id),
  ]);
  if (!ids.size) return [];
  return db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(and(inArray(users.id, [...ids]), isNull(users.passwordHash)))
    .orderBy(users.email)
    .all();
}

/**
 * The events where this person has a role or a team seat that the issuer does not
 * organize. A link sets the password of an account the whole portal shares, so an
 * organizer gets one, and it works, only while this is empty: otherwise an organizer of
 * one event could make another event's judge a co-organizer (or import them) and sign in
 * as that judge. An administrator, who can send anyone a reset link anyway, reaches
 * everyone.
 */
function beyondReach(db: DbOrTx, personId: string, issuerId: string): string[] {
  const issuer = db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, issuerId)).get();
  if (issuer?.isAdmin) return [];
  const runs = new Set(
    db
      .select({ eventId: userRoles.eventId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, issuerId), eq(userRoles.role, "organizer")))
      .all()
      .map((r) => r.eventId),
  );
  const theirs = new Set([
    ...db.select({ eventId: teamMembers.eventId }).from(teamMembers).where(eq(teamMembers.userId, personId)).all().map((r) => r.eventId),
    ...db.select({ eventId: userRoles.eventId }).from(userRoles).where(eq(userRoles.userId, personId)).all().map((r) => r.eventId),
  ]);
  return [...theirs].filter((id) => !runs.has(id));
}

/** How many people in the event without a password this organizer can make links for. */
export function countWithoutPassword(actor: Actor | null, eventIdOrSlug: string): number {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return passwordless(db, event.id).filter((p) => p.id !== actor!.userId && !beyondReach(db, p.id, actor!.userId).length).length;
}

/** How many more also belong to an event this organizer does not run: only an administrator's reset link reaches them. */
export function countBeyondReach(actor: Actor | null, eventIdOrSlug: string): number {
  const db = getDb();
  const event = requireEvent(db, eventIdOrSlug);
  guardRead(actor, "event.manage", { kind: "event", event: eventFacts(event) });
  return passwordless(db, event.id).filter((p) => p.id !== actor!.userId && beyondReach(db, p.id, actor!.userId).length > 0).length;
}

export type ClaimLink = { email: string; name: string; path: string };
export type ClaimSkip = { email: string; name: string };

/**
 * A fresh personal link for each person in the event without a password; returned this
 * once. `elsewhere` lists the people left out because they also belong to an event the
 * asking organizer does not run.
 */
export function makeClaimLinks(actor: Actor | null, eventIdOrSlug: string): { links: ClaimLink[]; elsewhere: ClaimSkip[] } {
  const { id: eventId } = requireEvent(getDb(), eventIdOrSlug);
  const now = nowIso();
  const expires = new Date(Date.parse(now) + CLAIM_DAYS * 86_400_000).toISOString();
  return mutate({
    actor,
    action: "event.manage",
    load: (tx) => ({ kind: "event", event: eventFacts(requireEvent(tx, eventId)) }),
    run: (tx) => {
      const links: ClaimLink[] = [];
      const elsewhere: ClaimSkip[] = [];
      // everyone but the organizer asking (a demo organizer has no password on purpose)
      for (const p of passwordless(tx, eventId).filter((x) => x.id !== actor!.userId)) {
        if (beyondReach(tx, p.id, actor!.userId).length) {
          elsewhere.push({ email: p.email, name: p.name });
          continue;
        }
        tx.delete(accountClaims).where(and(eq(accountClaims.userId, p.id), isNull(accountClaims.usedAt))).run();
        const token = newSecret(24);
        tx.insert(accountClaims).values({ tokenHash: sha256(token), userId: p.id, eventId, createdBy: actor!.userId, createdAt: now, expiresAt: expires }).run();
        links.push({ email: p.email, name: p.name, path: `/claim/${token}` });
      }
      return {
        result: { links, elsewhere },
        audit: links.length ? { action: "claims.issue", eventId, targetType: "event", targetId: eventId, after: { links: links.length, elsewhere: elsewhere.length } } : null,
      };
    },
  });
}

const OUT_OF_REACH =
  "This link no longer works: the account now also belongs to an event that the organizer who sent it does not run. Ask the portal's administrator for a password-reset link.";

function openClaim(token: string) {
  const db = getDb();
  const row = db
    .select({ tokenHash: accountClaims.tokenHash, userId: accountClaims.userId, eventId: accountClaims.eventId, createdBy: accountClaims.createdBy, usedAt: accountClaims.usedAt, expiresAt: accountClaims.expiresAt })
    .from(accountClaims)
    .where(eq(accountClaims.tokenHash, sha256(token)))
    .get();
  if (!row) throw new NotFoundError("Link");
  if (row.usedAt) throw new HttpError(410, "claim_used", "This link was used already. Sign in with the password you set.");
  if (Date.parse(row.expiresAt) <= Date.now()) throw new HttpError(410, "claim_expired", "This link has expired. Ask the organizers for a new one.");
  // checked again when the link is used: the person may have joined another event since it was made
  if (beyondReach(db, row.userId, row.createdBy).length) throw new HttpError(410, "claim_out_of_reach", OUT_OF_REACH);
  return row;
}

/** What the claim page shows before the person sets a password. Public: the token is the proof. */
export function describeClaim(token: string): { email: string; name: string; eventName: string; eventSlug: string } {
  const row = openClaim(token);
  const db = getDb();
  const user = db.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, row.userId)).get()!;
  const event = db.select({ name: events.name, slug: events.slug }).from(events).where(eq(events.id, row.eventId)).get()!;
  return { email: user.email, name: user.name, eventName: event.name, eventSlug: event.slug };
}

/** Set the password (and optionally the name) and sign in. The link then stops working. */
export async function claimAccount(token: string, body: unknown): Promise<{ userId: string }> {
  const row = openClaim(token);
  const input = parse(ClaimInput, body);
  const passwordHash = hashPassword(input.password);
  const db = getDb();
  const session = db.transaction((tx) => {
    const now = nowIso();
    // The guard in the WHERE makes a double submit harmless: only one of them finds the claim unused.
    const used = tx
      .update(accountClaims)
      .set({ usedAt: now })
      .where(and(eq(accountClaims.tokenHash, row.tokenHash), isNull(accountClaims.usedAt), gt(accountClaims.expiresAt, now)))
      .run();
    if (used.changes !== 1) throw new HttpError(410, "claim_used", "This link was used already. Sign in with the password you set.");
    // again inside the transaction, so a role gained between the check above and this write counts too
    if (beyondReach(tx, row.userId, row.createdBy).length) throw new HttpError(410, "claim_out_of_reach", OUT_OF_REACH);
    const user = tx.select({ name: users.name, passwordHash: users.passwordHash }).from(users).where(eq(users.id, row.userId)).get()!;
    if (user.passwordHash) throw new ValidationError("This account has a password already. Sign in instead.");
    const name = input.name ?? user.name;
    tx.update(users).set({ passwordHash, name }).where(eq(users.id, row.userId)).run();
    appendAudit(tx, { actorUserId: row.userId, actorLabel: name, action: "user.claim", eventId: row.eventId, targetType: "user", targetId: row.userId }, now);
    return createLoginSession(tx, row.userId);
  });
  await setSessionCookie(session.token, session.expires);
  return { userId: row.userId };
}
