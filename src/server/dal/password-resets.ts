import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "../authz";
import { appendAudit } from "../audit";
import { DEMO_ORGANIZER } from "../checker";
import { getDb } from "../db/client";
import { passwordResets, sessions, users } from "../db/schema";
import { ConflictError, HttpError, NotFoundError } from "../errors";
import { guardRead, mutate } from "../mutate";
import { createLoginSession, hashPassword, setSessionCookie } from "../session";
import { newSecret, nowIso, sha256 } from "../util";
import { parse } from "./parse";

// A forgotten password, without email: the person asks an administrator, who makes a
// one-time link for that account and hands it over. The link works once, within a day;
// a new one replaces an unused one. Setting the new password ends every signed-in
// session the account had, so whoever held the old password is out. API tokens are
// separate credentials and keep working until their owner revokes them. The demo
// identities are refused: they sign in by their one-click links, and a password set on
// one would outlive demo mode.

const RESET_HOURS = 24;

export const ResetLinkInput = z.object({ email: z.string().trim().toLowerCase().pipe(z.email()) });
export const ResetInput = z.object({ password: z.string().min(10, "at least 10 characters").max(200) });

export type ResetLink = { email: string; name: string; path: string; expiresAt: string };

/** The Accounts page's gate: administrators only, refused like any other read (a real 403). */
export function guardAccounts(actor: Actor | null): void {
  guardRead(actor, "portal.accounts", { kind: "platform" });
}

/** A one-time link for the account with this address, returned this once (administrators only). */
export function makePasswordReset(actor: Actor | null, body: unknown): ResetLink {
  const now = nowIso();
  const expiresAt = new Date(Date.parse(now) + RESET_HOURS * 3_600_000).toISOString();
  return mutate({
    actor,
    action: "portal.accounts",
    load: () => ({ kind: "platform" }),
    run: (tx) => {
      const { email } = parse(ResetLinkInput, body);
      const user = tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.email, email)).get();
      if (!user) throw new NotFoundError("Account");
      const demo =
        user.id === DEMO_ORGANIZER.id ||
        Boolean(tx.select({ u: sessions.userId }).from(sessions).where(and(eq(sessions.userId, user.id), eq(sessions.kind, "checker"))).get());
      if (demo) throw new ConflictError("demo_account", "This is a demo account: it signs in with its one-click link and has no password to reset.");
      tx.delete(passwordResets).where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt))).run();
      const token = newSecret(24);
      tx.insert(passwordResets).values({ tokenHash: sha256(token), userId: user.id, createdBy: actor!.userId, createdAt: now, expiresAt }).run();
      return {
        result: { email: user.email, name: user.name, path: `/reset/${token}`, expiresAt },
        audit: { action: "user.reset_link", eventId: null, targetType: "user", targetId: user.id, after: { expiresAt } },
      };
    },
  });
}

function openReset(token: string) {
  const row = getDb()
    .select({ tokenHash: passwordResets.tokenHash, userId: passwordResets.userId, usedAt: passwordResets.usedAt, expiresAt: passwordResets.expiresAt })
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, sha256(token)))
    .get();
  if (!row) throw new NotFoundError("Link");
  if (row.usedAt) throw new HttpError(410, "reset_used", "This link was used already. Sign in with your new password.");
  if (Date.parse(row.expiresAt) <= Date.now()) throw new HttpError(410, "reset_expired", "This link has expired. Ask an administrator for a new one.");
  return row;
}

/** Whose link this is, before the new password is set. Public: the token is the proof. */
export function describePasswordReset(token: string): { email: string; name: string } {
  const row = openReset(token);
  return getDb().select({ email: users.email, name: users.name }).from(users).where(eq(users.id, row.userId)).get()!;
}

/** Set the new password, end every signed-in session the account had, and sign in. The link then stops working. */
export async function resetPassword(token: string, body: unknown): Promise<{ userId: string; sessionsEnded: number }> {
  const row = openReset(token);
  const { password } = parse(ResetInput, body);
  const passwordHash = hashPassword(password);
  const out = getDb().transaction((tx) => {
    const now = nowIso();
    // The guard in the WHERE makes a double submit harmless: only one of them finds the link unused.
    const used = tx
      .update(passwordResets)
      .set({ usedAt: now })
      .where(and(eq(passwordResets.tokenHash, row.tokenHash), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
      .run();
    if (used.changes !== 1) throw new HttpError(410, "reset_used", "This link was used already. Sign in with your new password.");
    const user = tx.select({ name: users.name }).from(users).where(eq(users.id, row.userId)).get()!;
    tx.update(users).set({ passwordHash }).where(eq(users.id, row.userId)).run();
    const ended = tx.delete(sessions).where(and(eq(sessions.userId, row.userId), eq(sessions.kind, "login"))).run().changes;
    appendAudit(
      tx,
      { actorUserId: row.userId, actorLabel: user.name, action: "user.password_reset", eventId: null, targetType: "user", targetId: row.userId, after: { sessionsEnded: ended } },
      now,
    );
    return { session: createLoginSession(tx, row.userId), ended };
  });
  await setSessionCookie(out.session.token, out.session.expires);
  return { userId: row.userId, sessionsEnded: out.ended };
}
