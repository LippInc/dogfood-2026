import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { appendAudit } from "../audit";
import { getDb } from "../db/client";
import { users } from "../db/schema";
import { ConflictError, ValidationError } from "../errors";
import { createLoginSession, hashPassword, setSessionCookie } from "../session";
import { newId } from "../util";

export const SignUp = z.object({
  name: z.string().trim().min(1, "your name is required").max(80),
  email: z.string().trim().toLowerCase().email("that is not an email address").max(254),
  password: z.string().min(10, "at least 10 characters").max(200),
});

/**
 * Create an account and sign it in. An account has no role of its own: roles come
 * from joining a team (participant), a judge invite (judge) or creating an event
 * (organizer).
 */
export async function signUp(body: unknown): Promise<{ userId: string }> {
  const parsed = SignUp.safeParse(body);
  if (!parsed.success) throw new ValidationError("Check the highlighted fields.", z.flattenError(parsed.error).fieldErrors);
  const { name, email, password } = parsed.data;
  const passwordHash = hashPassword(password);
  const db = getDb();
  const session = db.transaction((tx) => {
    if (tx.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
      throw new ConflictError("email_taken", "An account with that email already exists. Sign in instead.");
    }
    const id = newId("usr");
    tx.insert(users).values({ id, email, name, passwordHash, isAdmin: false, createdAt: new Date().toISOString() }).run();
    appendAudit(tx, { actorUserId: id, actorLabel: name, action: "user.sign_up", targetType: "user", targetId: id });
    return { id, ...createLoginSession(tx, id) };
  });
  await setSessionCookie(session.token, session.expires);
  return { userId: session.id };
}
