import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminEmails, consumeSetupCode, setupCodeValid } from "../admins";
import { appendAudit } from "../audit";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { ConflictError, HttpError, RateLimitedError } from "../errors";
import { createLoginSession, hashPassword, setSessionCookie } from "../session";
import { newId } from "../util";
import { addressLimit } from "./auth";
import type { Client } from "./voting";
import { parse } from "./parse";

function refuseTaken(existing: { passwordHash: string | null } | undefined): void {
  if (existing && !existing.passwordHash) {
    throw new ConflictError("account_imported", "The organizers added this address to an event. Open the personal link they sent you to set your password.");
  }
  if (existing) throw new ConflictError("email_taken", "An account with that email already exists. Sign in instead.");
}

export const SignUp = z.object({
  name: z.string().trim().min(1, "your name is required").max(80),
  email: z.string().trim().toLowerCase().email("that is not an email address").max(254),
  password: z.string().min(10, "at least 10 characters").max(200),
  /** the one-time administrator setup code from the server log, for an address in ADMIN_EMAILS */
  setup: z.string().max(200).optional(),
});

/**
 * Create an account and sign it in. An account has no role of its own: roles come
 * from joining a team (participant), a judge invite (judge) or creating an event
 * (organizer). An address named in ADMIN_EMAILS signs up as an administrator, and
 * only with the setup code the portal printed in its log at start (admins.ts).
 */
export async function signUp(body: unknown, client?: Client): Promise<{ userId: string }> {
  const { name, email, password, setup } = parse(SignUp, body);
  const wait = addressLimit(client);
  if (wait) throw new RateLimitedError(wait);
  const isAdmin = adminEmails().has(email);
  if (isAdmin && !setupCodeValid(setup)) {
    throw new HttpError(403, "admin_setup_required", "This address is kept for the portal's administrator. Open the setup link from the server log to sign up with it.");
  }
  const db = getDb();
  // a taken address is refused before the password is hashed (the hash is the costly part)
  refuseTaken(db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)).get());
  const passwordHash = hashPassword(password);
  const session = db.transaction((tx) => {
    refuseTaken(tx.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.email, email)).get());
    const id = newId("usr");
    tx.insert(users).values({ id, email, name, passwordHash, isAdmin, createdAt: new Date().toISOString() }).run();
    appendAudit(tx, { actorUserId: id, actorLabel: name, action: "user.sign_up", targetType: "user", targetId: id, after: isAdmin ? { isAdmin: true, by: "ADMIN_EMAILS" } : null });
    return { id, ...createLoginSession(tx, id) };
  });
  if (isAdmin) consumeSetupCode();
  await setSessionCookie(session.token, session.expires);
  return { userId: session.id };
}
