import "server-only";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import type { Actor } from "./authz";
import { getDb, type DbOrTx } from "./db/client";
import { sessions, userRoles, users } from "./db/schema";
import { newSecret, sha256 } from "./util";

export const SESSION_COOKIE = "session";
const LOGIN_SESSION_DAYS = 14;

/** Resolve a raw session token to its actor, or null when it is unknown or expired. */
export function actorForToken(db: DbOrTx, token: string, now = new Date()): Actor | null {
  if (!token || token.length > 256) return null;
  const row = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      isAdmin: users.isAdmin,
      kind: sessions.kind,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, sha256(token)))
    .get();
  if (!row || Date.parse(row.expiresAt) <= now.getTime()) return null;
  const roles = db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, row.userId))
    .all();
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    isAdmin: row.isAdmin,
    roles,
    sessionKind: row.kind,
  };
}

/** The token a request carries: the session cookie, or an Authorization: Bearer header. */
export async function requestToken(): Promise<string | null> {
  const jar = await cookies();
  const fromCookie = jar.get(SESSION_COOKIE)?.value;
  if (fromCookie) return fromCookie;
  const auth = (await headers()).get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim() || null;
  return null;
}

/** The signed-in actor for this request, or null for a visitor. */
export async function currentActor(): Promise<Actor | null> {
  const token = await requestToken();
  return token ? actorForToken(getDb(), token) : null;
}

/** Create a login session row; the caller sets the cookie once its transaction commits. */
export function createLoginSession(db: DbOrTx, userId: string, now = new Date()): { token: string; expires: Date } {
  const token = newSecret(32);
  const expires = new Date(now.getTime() + LOGIN_SESSION_DAYS * 86_400_000);
  db.insert(sessions)
    .values({
      tokenHash: sha256(token),
      userId,
      kind: "login",
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    })
    .run();
  return { token, expires };
}

/** Set the session cookie. Server actions and route handlers only. */
export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.COOKIE_SECURE === "true",
    expires,
  });
}

/** End this browser's login session. Checker sessions are never deleted here. */
export async function endSession(db: DbOrTx): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    const hash = sha256(token);
    const row = db.select({ kind: sessions.kind }).from(sessions).where(eq(sessions.tokenHash, hash)).get();
    if (row?.kind === "login") db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
  }
  jar.delete(SESSION_COOKIE);
}

// ---------------------------------------------------------------------------
// Passwords: Node's built-in argon2id (m = 19456 KiB, t = 2, p = 1), stored as a
// PHC-style string so the parameters travel with the hash.
// ---------------------------------------------------------------------------

const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const;

export function hashPassword(password: string): string {
  const nonce = crypto.randomBytes(16);
  const tag = crypto.argon2Sync("argon2id", { message: password, nonce, ...ARGON });
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${nonce.toString("base64")}$${tag.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5], "base64");
  const tag = crypto.argon2Sync("argon2id", {
    message: password,
    nonce: Buffer.from(m[4], "base64"),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return crypto.timingSafeEqual(tag, expected);
}
