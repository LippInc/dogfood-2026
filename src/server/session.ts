import "server-only";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import type { Actor } from "./authz";
import { getDb, type DbOrTx } from "./db/client";
import { apiTokens, sessions, userRoles, users } from "./db/schema";
import { operatorCount, secureCookies } from "./settings";
import { newSecret, sha256 } from "./util";

export const SESSION_COOKIE = "session";

/** Resolve a raw session token or API token to its actor, or null when it is unknown, expired or revoked. */
export function actorForToken(db: DbOrTx, token: string, now = new Date()): Actor | null {
  if (!token || token.length > 256) return null;
  if (token.startsWith(API_TOKEN_PREFIX)) return actorForApiToken(db, token, now);
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

export const API_TOKEN_PREFIX = "dfk_";

/** Set after the first failed "last used" write, so a broken volume logs it once, not on every request. */
let lastUsedWriteFailed = false;

function actorForApiToken(db: DbOrTx, token: string, now: Date): Actor | null {
  const row = db
    .select({ id: apiTokens.id, userId: users.id, name: users.name, email: users.email, isAdmin: users.isAdmin, expiresAt: apiTokens.expiresAt, revokedAt: apiTokens.revokedAt, lastUsedAt: apiTokens.lastUsedAt })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, sha256(token)))
    .get();
  if (!row || row.revokedAt || (row.expiresAt && Date.parse(row.expiresAt) <= now.getTime())) return null;
  // "last used" to the minute: one small write a minute per token at most. On a read-only or full volume
  // the write fails; a missed minute is fine, so the request goes on (reads keep working, as
  // docs/OPERATIONS.md says) and the failure is logged once per process.
  if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) > 60_000) {
    try {
      db.update(apiTokens).set({ lastUsedAt: now.toISOString() }).where(eq(apiTokens.id, row.id)).run();
    } catch (err) {
      if (!lastUsedWriteFailed) {
        lastUsedWriteFailed = true;
        console.warn(`[session] could not record an API token's last used time, going on without it: ${(err as Error).message}`);
      }
    }
  }
  const roles = db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, row.userId)).all();
  return { userId: row.userId, name: row.name, email: row.email, isAdmin: row.isAdmin, roles, sessionKind: "api" };
}

/**
 * The token a request carries: the session cookie, or an Authorization: Bearer header. `cookie: false` reads the
 * header alone, for a route the proxy does not see that must drop a cross-origin write's cookies itself.
 */
export async function requestToken({ cookie = true }: { cookie?: boolean } = {}): Promise<string | null> {
  const fromCookie = cookie ? (await cookies()).get(SESSION_COOKIE)?.value : undefined;
  if (fromCookie) return fromCookie;
  return bearerToken(await headers());
}

/** The token of an Authorization: Bearer header, or null. */
function bearerToken(h: Headers): string | null {
  const auth = h.get("authorization");
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, "").trim() || null;
  return null;
}

/** The signed-in actor for this request, or null for a visitor; `cookie: false` as for requestToken(). */
export async function currentActor({ cookie = true }: { cookie?: boolean } = {}): Promise<Actor | null> {
  const token = await requestToken({ cookie });
  return token ? actorForToken(getDb(), token) : null;
}

/** Create a login session row; the caller sets the cookie once its transaction commits. */
export function createLoginSession(db: DbOrTx, userId: string, now = new Date()): { token: string; expires: Date } {
  const token = newSecret(32);
  // SESSION_DAYS (default 14): a judging window a month long wants more; a session made
  // before a change keeps the end it was given.
  const expires = new Date(now.getTime() + operatorCount("SESSION_DAYS") * 86_400_000);
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
    secure: secureCookies(),
    expires,
  });
}

/** Sign-out's answer: signedOut is false while a credential the request carried still works; reason says what stays. */
export type SignOutResult = { signedOut: boolean; reason?: string };

const CHECKER_KEPT =
  "This is one of the four checker sessions, which sign-out never ends (the acceptance checks use them); it stays valid until the portal starts with SEED_CHECKER_SESSIONS off.";
const API_TOKEN_KEPT =
  "An API token is not a session, so sign-out does not end it: revoke it at /account/tokens or with POST /api/tokens/{token}/revoke.";

/** Delete a login session by its raw token; answers the kind the token had, or null for a token no session has. */
function endLoginSession(db: DbOrTx, token: string): "login" | "checker" | null {
  const hash = sha256(token);
  const row = db.select({ kind: sessions.kind }).from(sessions).where(eq(sessions.tokenHash, hash)).get();
  if (row?.kind === "login") db.delete(sessions).where(eq(sessions.tokenHash, hash)).run();
  return row?.kind ?? null;
}

function liveApiToken(db: DbOrTx, token: string, now: Date): boolean {
  const row = db.select({ revokedAt: apiTokens.revokedAt, expiresAt: apiTokens.expiresAt }).from(apiTokens).where(eq(apiTokens.tokenHash, sha256(token))).get();
  return Boolean(row && !row.revokedAt && (!row.expiresAt || Date.parse(row.expiresAt) > now.getTime()));
}

/**
 * End the login sessions this request carries: the session cookie's (the cookie is cleared either way) and an
 * Authorization: Bearer session token's. Checker sessions are never ended and an API token sent as Bearer is not a
 * session: either keeps working for its caller, so the answer is then signedOut: false, with the reason.
 */
export async function endSession(db: DbOrTx, now = new Date()): Promise<SignOutResult> {
  const jar = await cookies();
  const fromCookie = jar.get(SESSION_COOKIE)?.value;
  const fromHeader = bearerToken(await headers());
  const reasons = new Set<string>();
  let stillSignedIn = false;
  // A checker session is never ended, so whoever holds its token (a script sending the printed Cookie header, or a
  // Bearer) is still signed in; a browser's own form post gets the 303, not this answer.
  if (fromCookie && endLoginSession(db, fromCookie) === "checker") {
    stillSignedIn = true;
    reasons.add(CHECKER_KEPT);
  }
  if (fromHeader) {
    if (fromHeader.startsWith(API_TOKEN_PREFIX)) {
      if (liveApiToken(db, fromHeader, now)) {
        stillSignedIn = true;
        reasons.add(API_TOKEN_KEPT);
      }
    } else if (endLoginSession(db, fromHeader) === "checker") {
      stillSignedIn = true;
      reasons.add(CHECKER_KEPT);
    }
  }
  jar.delete(SESSION_COOKIE);
  return reasons.size ? { signedOut: !stillSignedIn, reason: [...reasons].join(" ") } : { signedOut: true };
}

// ---------------------------------------------------------------------------
// Passwords: Node's built-in argon2id (m = 19456 KiB, t = 2, p = 1), stored as a
// PHC-style string so the parameters travel with the hash.
// ---------------------------------------------------------------------------

const ARGON = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 } as const;

/** crypto.argon2Sync, which only recent Node 24 releases have: an older Node gets a clear error, not a stack trace. */
function argon2id(params: Parameters<typeof crypto.argon2Sync>[1]): Buffer {
  if (typeof crypto.argon2Sync !== "function") {
    throw new Error(`Passwords need Node's built-in argon2 (crypto.argon2Sync), which this Node ${process.version} lacks: use a current Node 24, as the Docker image does.`);
  }
  return crypto.argon2Sync("argon2id", params);
}

export function hashPassword(password: string): string {
  const nonce = crypto.randomBytes(16);
  const tag = argon2id({ message: password, nonce, ...ARGON });
  return `$argon2id$v=19$m=${ARGON.memory},t=${ARGON.passes},p=${ARGON.parallelism}$${nonce.toString("base64")}$${tag.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[5], "base64");
  const tag = argon2id({
    message: password,
    nonce: Buffer.from(m[4], "base64"),
    memory: Number(m[1]),
    passes: Number(m[2]),
    parallelism: Number(m[3]),
    tagLength: expected.length,
  });
  return crypto.timingSafeEqual(tag, expected);
}
