import "server-only";
import { eq, inArray, sql } from "drizzle-orm";
import { appendAudit } from "../audit";
import { CHECKER_LABELS, checkerSessionsEnabled, type CheckerLabel } from "../checker";
import { getDb } from "../db/client";
import { events, sessions, teamMembers, teams, userRoles, users } from "../db/schema";
import { LIMITS, take } from "../rate-limit";
import { createLoginSession, endSession, setSessionCookie, verifyPassword } from "../session";

// A stored hash for "no such user", so an unknown email costs the same argon2 time
// as a wrong password and the timing does not reveal which emails exist.
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$ZG9nZm9vZC1kdW1teS1ub25jZQ==$9Q0AU1DzI8Yw4lX8x1n8y0m5Jf9r3o0z2vS7iQ6bT5g=";

export type SignInResult = { ok: true; userId: string } | { ok: false; message: string; retryAfter?: number };

export async function signInWithPassword(emailRaw: string, password: string): Promise<SignInResult> {
  const email = emailRaw.trim().toLowerCase();
  const db = getDb();
  // Password guessing: at most 10 tries per address per 15 minutes, whoever sends them.
  const t = take(`signin:${email}`, LIMITS.signIn);
  if (!t.ok) {
    if (t.firstRefusal) {
      db.transaction((tx) =>
        appendAudit(tx, { actorUserId: null, actorLabel: "anonymous", action: "ratelimit.refused", targetType: "limit", targetId: "sign-in", after: { retryAfter: t.retryAfter } }),
      );
    }
    return { ok: false, message: `Too many attempts for this address. Try again in ${Math.ceil(t.retryAfter / 60)} min.`, retryAfter: t.retryAfter };
  }
  const user = db.select().from(users).where(eq(users.email, email)).get();
  const valid = verifyPassword(password, user?.passwordHash ?? DUMMY_HASH) && Boolean(user?.passwordHash);
  if (!user || !valid) return { ok: false, message: "That email and password do not match an account here." };
  const session = db.transaction((tx) => {
    const s = createLoginSession(tx, user.id);
    appendAudit(tx, { actorUserId: user.id, actorLabel: user.name, action: "session.sign_in", targetType: "user", targetId: user.id });
    return s;
  });
  await setSessionCookie(session.token, session.expires);
  return { ok: true, userId: user.id };
}

export async function signOut(): Promise<void> {
  await endSession(getDb());
}

export type DemoIdentity = { label: CheckerLabel; userId: string; name: string; detail: string };

/**
 * The four seeded identities, offered as one-click sign-ins while the portal runs
 * with SEED_CHECKER_SESSIONS=true (the demo and judging setup). Empty otherwise.
 */
export function demoIdentities(): DemoIdentity[] {
  if (!checkerSessionsEnabled()) return [];
  const db = getDb();
  const rows = db
    .select({ label: sessions.label, userId: users.id, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.kind, "checker"))
    .all();
  const byLabel = new Map(rows.map((r) => [r.label, r]));
  const ids = rows.map((r) => r.userId);
  const teamNames = new Map(
    ids.length
      ? db
          .select({ userId: teamMembers.userId, name: teams.name })
          .from(teamMembers)
          .innerJoin(teams, eq(teams.id, teamMembers.teamId))
          .where(inArray(teamMembers.userId, ids))
          .all()
          .map((r) => [r.userId, r.name])
      : [],
  );
  const detail: Record<CheckerLabel, (userId: string) => string> = {
    organizer: () => "Organizer of every seeded event",
    judge_a: (u) => `Judge ${u}`,
    judge_b: (u) => `Judge ${u}`,
    participant: (u) => `Member of team ${teamNames.get(u) ?? "?"}`,
  };
  return CHECKER_LABELS.flatMap((label) => {
    const r = byLabel.get(label);
    return r ? [{ label, userId: r.userId, name: r.name, detail: detail[label](r.userId) }] : [];
  });
}

/** Start a normal login session (never the checker token) as one of the demo identities. */
export async function signInAsDemo(label: string): Promise<SignInResult> {
  const identity = demoIdentities().find((d) => d.label === label);
  if (!identity) return { ok: false, message: "Demo sign-in is switched off on this portal." };
  const session = getDb().transaction((tx) => {
    const s = createLoginSession(tx, identity.userId);
    appendAudit(tx, {
      actorUserId: identity.userId,
      actorLabel: identity.name,
      action: "session.sign_in_demo",
      targetType: "user",
      targetId: identity.userId,
      after: { as: label },
    });
    return s;
  });
  await setSessionCookie(session.token, session.expires);
  return { ok: true, userId: identity.userId };
}

/** Where to land after signing in: the first place the person's roles lead to. */
export function homeFor(userId: string): string {
  const db = getDb();
  const roles = db
    .select({ role: userRoles.role, slug: events.slug })
    .from(userRoles)
    .innerJoin(events, eq(events.id, userRoles.eventId))
    .where(eq(userRoles.userId, userId))
    .all();
  const order = ["organizer", "judge", "participant"] as const;
  for (const role of order) {
    const r = roles.find((x) => x.role === role);
    if (r) return role === "participant" ? `/events/${r.slug}` : role === "judge" ? `/judge/${r.slug}` : `/organize/${r.slug}`;
  }
  return "/";
}

export function healthCheck(): { ok: boolean; events: number } {
  const row = getDb().select({ n: sql<number>`count(*)` }).from(events).get();
  const n = row?.n ?? 0;
  // seeded means ready, unless the portal was asked to start empty (FIXTURES_PATH=none)
  return { ok: n > 0 || process.env.FIXTURES_PATH === "none", events: n };
}
