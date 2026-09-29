import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { accountClaims, apiTokens, assignments, events, judgeInvites, judgeTracks, passwordResets, sessions, teamMembers, teams, userRoles, users, webhooks } from "./db/schema";
import { appendAudit } from "./audit";
import { sha256 } from "./util";

// Deterministic checker sessions. The acceptance checker
// never logs in: it sends four headers. The seed derives each token from
// DOGFOOD_SEED_SECRET, stores only its SHA-256, and upserts the four sessions on
// every boot, so `docker compose down -v && up` reproduces the same headers and a
// deleted session comes back on restart. The tokens are public (they sit in the
// committed .dogfood.toml), so production turns SEED_CHECKER_SESSIONS off, which
// also removes any checker session left in the database.

export const DEFAULT_SEED_SECRET = "dogfood-2026-public-demo-secret";
export const CHECKER_LABELS = ["organizer", "judge_a", "judge_b", "participant"] as const;
export type CheckerLabel = (typeof CHECKER_LABELS)[number];

const PREFIX: Record<CheckerLabel, string> = {
  organizer: "org",
  judge_a: "jda",
  judge_b: "jdb",
  participant: "prt",
};

export const DEMO_ORGANIZER = {
  id: "usr_organizer",
  email: "organizer@example.org",
  name: "Demo Organizer",
} as const;

const NEVER = "2100-01-01T00:00:00.000Z";

export function checkerSessionsEnabled(): boolean {
  return process.env.SEED_CHECKER_SESSIONS === "true" && demoModeRefusal() === null;
}

/**
 * Why demo mode is refused although SEED_CHECKER_SESSIONS=true asks for it, or null.
 * Demo mode is for the judges' own machines: its sign-in page lets anyone act as the demo
 * organizer, an administrator, with one click, and with the public default secret anyone who
 * reads this repository can also derive the four session tokens. So on a PUBLIC_URL that is
 * not a local address it is refused whatever the secret, unless PUBLIC_DEMO=true says a
 * public demo is meant (and then only with an own secret).
 */
export function demoModeRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.SEED_CHECKER_SESSIONS !== "true") return null;
  const url = env.PUBLIC_URL ?? "http://localhost:8080";
  if (isLocalUrl(url)) return null;
  if (!ownSecret(env)) {
    return `PUBLIC_URL (${url}) is not a local address and DOGFOOD_SEED_SECRET is the public default, so anyone could derive the organizer's session`;
  }
  if (env.PUBLIC_DEMO === "true") return null;
  return `PUBLIC_URL (${url}) is not a local address, and demo mode would let anyone who opens the sign-in page act as the demo organizer, an administrator; set PUBLIC_DEMO=true only to run a public demo on purpose`;
}

/**
 * Why the portal will not start at all, or null. The public default secret would seal the signing key (a copy
 * of the database could then sign certificates) and salt the voters' address hashes (every IPv4 address could
 * be tried against them). It runs only the local demo: SEED_CHECKER_SESSIONS=true (the shipped compose file) on
 * this machine's own address. Outside demo mode it is refused whatever PUBLIC_URL says, since a portal behind a
 * reverse proxy may leave PUBLIC_URL unset and still be reached by others; on another address it is refused
 * demo mode or not.
 */
export function startRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (ownSecret(env)) return null;
  const url = env.PUBLIC_URL ?? "http://localhost:8080";
  if (!isLocalUrl(url)) {
    return `PUBLIC_URL (${url}) is not a local address and DOGFOOD_SEED_SECRET is the public default, which seals the signing key and salts the voters' address hashes: set DOGFOOD_SEED_SECRET to a long random string of your own, and keep it`;
  }
  if (env.SEED_CHECKER_SESSIONS === "true") return null;
  return `DOGFOOD_SEED_SECRET is ${env.DOGFOOD_SEED_SECRET ? "the public default" : "not set, so the public default"} and demo mode is off (SEED_CHECKER_SESSIONS is not true); the default, which anyone can read in this repository, would seal the signing key and salt the voters' address hashes: set DOGFOOD_SEED_SECRET to a long random string of your own (for example the output of openssl rand -hex 32), and keep it. Only the local demo (SEED_CHECKER_SESSIONS=true on this machine's own address) runs on the default`;
}

const ownSecret = (env: NodeJS.ProcessEnv) => Boolean(env.DOGFOOD_SEED_SECRET) && env.DOGFOOD_SEED_SECRET !== DEFAULT_SEED_SECRET;

/** This machine's own address: localhost, a name under .localhost, 127.x.x.x or ::1. A malformed address is not. */
function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Plain letters and digits, so both TOML parsers in run.py read it the same way. */
export function checkerToken(label: CheckerLabel, secret = process.env.DOGFOOD_SEED_SECRET || DEFAULT_SEED_SECRET): string {
  const mac = crypto.createHmac("sha256", secret).update(`dogfood-checker-session:${label}`).digest("hex");
  return `${PREFIX[label]}${mac.slice(0, 32)}`;
}

export type CheckerIdentity = { label: CheckerLabel; userId: string; name: string; token: string };

/**
 * Pick the four identities from what is in the database, the same way every boot:
 * only people who hold the judge role with at least one track are candidates (a removed
 * judge's kept reviews still count as assignments, so the busiest assignee may no longer be
 * a judge). judge_a is the candidate with the most reviews (ties: lowest id) among those who
 * share a track with another candidate, judge_b the candidate with the most reviews among
 * those sharing a track with judge_a, and the participant is the first member of the first
 * team who holds no judge role. On the fixture that is always jdg_24 and jdg_26. Once
 * chosen, an identity stays while it still fits (the account in the label's session is kept
 * first), so the committed .dogfood.toml, whose peer-scores route names judge_a, stays true
 * when the organizers move other judges or change who is busiest. A label no one fits is
 * skipped with the reason: the organizers can remove or move judges, and that must never
 * stop the portal from starting.
 */
export function chooseCheckerUsers(db: Db, eventId: string): { chosen: Partial<Record<CheckerLabel, string>>; skipped: CheckerSkip[] } {
  const judges = new Set(
    db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .all()
      .map((r) => r.u),
  );
  const tracksOf = new Map<string, Set<string>>();
  for (const r of db.select({ u: judgeTracks.judgeUserId, t: judgeTracks.trackId }).from(judgeTracks).where(eq(judgeTracks.eventId, eventId)).all()) {
    if (!judges.has(r.u)) continue;
    tracksOf.set(r.u, (tracksOf.get(r.u) ?? new Set<string>()).add(r.t));
  }
  const load = new Map(
    db
      .select({ judge: assignments.judgeUserId, n: sql<number>`count(*)` })
      .from(assignments)
      .where(eq(assignments.eventId, eventId))
      .groupBy(assignments.judgeUserId)
      .all()
      .map((r) => [r.judge, r.n]),
  );
  // Busiest first, then lowest id: the same order every boot.
  const candidates = [...tracksOf.keys()].sort((x, y) => (load.get(y) ?? 0) - (load.get(x) ?? 0) || (x < y ? -1 : x > y ? 1 : 0));
  const shares = (x: string, y: string) => x !== y && [...tracksOf.get(x)!].some((t) => tracksOf.get(y)!.has(t));
  const skipped: CheckerSkip[] = [];
  const chosen: Partial<Record<CheckerLabel, string>> = { organizer: DEMO_ORGANIZER.id };

  // the account each label's session named at the last start, if any
  const before = new Map(
    db
      .select({ label: sessions.label, u: sessions.userId })
      .from(sessions)
      .where(eq(sessions.kind, "checker"))
      .all()
      .map((r) => [r.label, r.u]),
  );
  const keptA = before.get("judge_a");
  const judgeA =
    (keptA && tracksOf.has(keptA) && candidates.some((b) => shares(keptA, b)) ? keptA : undefined) ??
    candidates.find((a) => candidates.some((b) => shares(a, b))) ??
    candidates[0];
  const keptB = before.get("judge_b");
  const judgeB = judgeA ? ((keptB && tracksOf.has(keptB) && shares(judgeA, keptB) ? keptB : undefined) ?? candidates.find((b) => shares(judgeA, b))) : undefined;
  if (judgeA) chosen.judge_a = judgeA;
  else skipped.push({ label: "judge_a", why: "the event has no judge with a track" });
  if (judgeB) chosen.judge_b = judgeB;
  else skipped.push({ label: "judge_b", why: judgeA ? "no second judge shares a track with judge_a" : "the event has no judge with a track" });

  const members = db
    .select({ userId: teamMembers.userId, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.eventId, eventId))
    .orderBy(teams.id, sql`${teamMembers.role} = 'member'`, teamMembers.joinedAt, teamMembers.userId)
    .all();
  const keptP = before.get("participant");
  const participant = (keptP && members.some((m) => m.userId === keptP) && !judges.has(keptP) ? keptP : undefined) ?? members.find((m) => !judges.has(m.userId))?.userId;
  if (participant) chosen.participant = participant;
  else skipped.push({ label: "participant", why: "no team member without a judge role" });

  return { chosen, skipped };
}

/** A checker label left without a session this boot, and why. */
export type CheckerSkip = { label: CheckerLabel; why: string };

/** Create the demo organizer (admin, organizer of the event), or make it admin again. Idempotent. */
export function ensureDemoOrganizer(db: Db, eventId: string, now: string): void {
  db.insert(users)
    .values({ ...DEMO_ORGANIZER, passwordHash: null, isAdmin: true, createdAt: now })
    .onConflictDoUpdate({ target: users.id, set: { isAdmin: true } })
    .run();
  db.insert(userRoles)
    .values({ userId: DEMO_ORGANIZER.id, eventId, role: "organizer", createdAt: now })
    .onConflictDoNothing()
    .run();
}

export type CheckerSeedResult =
  | { enabled: true; identities: CheckerIdentity[]; changed: CheckerLabel[]; skipped: CheckerSkip[] }
  | { enabled: false; removed: number; signedOut: number; demoted: boolean; revoked: DemoGrants };

/** What the demo identities handed out that outlives a session, ended when demo mode goes off. */
export type DemoGrants = { apiTokens: number; webhooks: number; claimLinks: number; resetLinks: number; judgeInvites: number };

/** Upsert (or, when disabled, remove) the four checker sessions. Synchronous. */
export function seedCheckerSessions(db: Db, eventId: string, now: string): CheckerSeedResult {
  return db.transaction((tx) => {
    if (!checkerSessionsEnabled()) {
      // Demo mode off: the checker sessions go, and so does everything the demo sign-in
      // buttons handed out for the same identities (ordinary sessions, SESSION_DAYS long), and the
      // demo organizer stops being an administrator, on a reused volume too.
      const demoUsers = [
        ...new Set([DEMO_ORGANIZER.id, ...tx.select({ u: sessions.userId }).from(sessions).where(eq(sessions.kind, "checker")).all().map((r) => r.u)]),
      ];
      const removed = tx.delete(sessions).where(eq(sessions.kind, "checker")).run().changes;
      const signedOut = tx.delete(sessions).where(inArray(sessions.userId, demoUsers)).run().changes;
      const demoted = tx.update(users).set({ isAdmin: false }).where(and(eq(users.id, DEMO_ORGANIZER.id), eq(users.isAdmin, true))).run().changes > 0;
      // Anyone could act as these identities while demo mode was on, so what they handed out
      // that outlives a session ends too: API tokens are revoked, webhooks turned off, unused
      // account and password reset links deleted and open judge invites revoked.
      const revoked: DemoGrants = {
        apiTokens: tx.update(apiTokens).set({ revokedAt: now }).where(and(inArray(apiTokens.userId, demoUsers), isNull(apiTokens.revokedAt))).run().changes,
        webhooks: tx.update(webhooks).set({ disabledAt: now }).where(and(inArray(webhooks.createdBy, demoUsers), isNull(webhooks.disabledAt))).run().changes,
        claimLinks: tx.delete(accountClaims).where(and(inArray(accountClaims.createdBy, demoUsers), isNull(accountClaims.usedAt))).run().changes,
        resetLinks: tx.delete(passwordResets).where(and(inArray(passwordResets.createdBy, demoUsers), isNull(passwordResets.usedAt))).run().changes,
        judgeInvites: tx
          .update(judgeInvites)
          .set({ revokedAt: now })
          .where(and(inArray(judgeInvites.createdBy, demoUsers), isNull(judgeInvites.acceptedAt), isNull(judgeInvites.revokedAt)))
          .run().changes,
      };
      const anyRevoked = Object.values(revoked).some((n) => n > 0);
      if (removed > 0 || signedOut > 0 || demoted || anyRevoked) {
        appendAudit(tx, { actorUserId: null, actorLabel: "system", action: "checker_sessions.removed", after: { removed, signedOut, demoted, revoked } }, now);
      }
      return { enabled: false as const, removed, signedOut, demoted, revoked };
    }
    const { chosen, skipped } = chooseCheckerUsers(tx as unknown as Db, eventId);
    const identities: CheckerIdentity[] = [];
    const changed: CheckerLabel[] = [];
    for (const label of CHECKER_LABELS) {
      const token = checkerToken(label);
      const tokenHash = sha256(token);
      const userId = chosen[label];
      const before = tx.select().from(sessions).where(eq(sessions.label, label)).get();
      if (!userId) {
        // Skipped this boot: an earlier boot's session for the label goes, so its public token
        // opens nothing rather than an account that is no longer, say, a judge.
        if (before) {
          tx.delete(sessions).where(eq(sessions.label, label)).run();
          changed.push(label);
        }
        continue;
      }
      if (!before || before.tokenHash !== tokenHash || before.userId !== userId) changed.push(label);
      tx.insert(sessions)
        .values({ tokenHash, userId, kind: "checker", label, createdAt: now, expiresAt: NEVER })
        .onConflictDoUpdate({ target: sessions.label, set: { tokenHash, userId, kind: "checker", expiresAt: NEVER } })
        .run();
      const name = tx.select({ name: users.name }).from(users).where(eq(users.id, userId)).get()?.name ?? userId;
      identities.push({ label, userId, name, token });
    }
    if (changed.length > 0) {
      appendAudit(
        tx,
        {
          actorUserId: null,
          actorLabel: "system",
          action: "checker_sessions.issued",
          eventId,
          after: { ...Object.fromEntries(identities.map((i) => [i.label, i.userId])), ...(skipped.length ? { skipped } : {}) },
        },
        now,
      );
    }
    return { enabled: true as const, identities, changed, skipped };
  });
}

/** The demo vote's open link: derived from the seed secret, like the checker tokens. */
export function demoVoteCode(secret = process.env.DOGFOOD_SEED_SECRET || DEFAULT_SEED_SECRET): string {
  const mac = crypto.createHmac("sha256", secret).update("dogfood-demo-vote-link").digest("hex");
  return `vote${mac.slice(0, 24)}`;
}

export const DEMO_VOTE_DAYS = 30;

/**
 * Demo mode only: give the sample event a community vote a visitor can try, open from
 * the first start for 30 days to signed-in accounts and to one open link. Only when the
 * event has no voting set up, so an organizer's own settings are never replaced; the
 * link is printed at boot. Audited as the system.
 */
export function seedDemoVote(db: Db, eventId: string, now: string): { opened: boolean; code: string; closesAt: string | null } {
  const code = demoVoteCode();
  return db.transaction((tx) => {
    const event = tx.select().from(events).where(eq(events.id, eventId)).get();
    if (!event) return { opened: false, code, closesAt: null };
    // Publishing ends the vote (dal/voting.ts endVoteForPublish): none opens after it.
    if (event.resultsPublishedAt) return { opened: false, code: "", closesAt: null };
    if (event.votingOpenAt || event.votingCloseAt || event.settings.voting) {
      const linked = event.settings.voting?.linkHash === sha256(code);
      return { opened: false, code: linked ? code : "", closesAt: event.votingCloseAt };
    }
    const openAt = `${now.slice(0, 16)}:00.000Z`;
    const closesAt = new Date(Date.parse(openAt) + DEMO_VOTE_DAYS * 86_400_000).toISOString();
    // The open link's ballots are counted apart and do not add to the result, as on a real event
    // whose organizer has not chosen otherwise.
    const voting = { modes: ["account", "link"] as ("account" | "link")[], votesPerVoter: 3, linkHash: sha256(code), countLink: false };
    tx.update(events)
      .set({ votingOpenAt: openAt, votingCloseAt: closesAt, settings: { ...event.settings, voting } })
      .where(eq(events.id, eventId))
      .run();
    appendAudit(
      tx,
      {
        actorUserId: null,
        actorLabel: "system",
        action: "voting.demo_opened",
        eventId,
        targetType: "event",
        targetId: eventId,
        after: { votingOpenAt: openAt, votingCloseAt: closesAt, modes: voting.modes, votesPerVoter: voting.votesPerVoter, countLink: voting.countLink },
      },
      now,
    );
    return { opened: true, code, closesAt };
  });
}

/** The [auth] and [routes] blocks of .dogfood.toml, ready to paste. */
export function checkerToml(identities: CheckerIdentity[], event: { id: string; slug: string }): string {
  const judgeA = identities.find((i) => i.label === "judge_a");
  const pad = (s: string) => s.padEnd(11);
  return [
    "[auth]",
    ...identities.map((i) => `${pad(i.label)} = "Cookie: session=${i.token}"`),
    "",
    "[routes]",
    `gallery      = "/events/${event.slug}"`,
    `submit       = "/api/events/${event.id}/projects"`,
    `judge_scores = "/api/judge/scores"`,
    judgeA ? `peer_scores  = "/api/judge/scores?judge=${judgeA.userId}"` : "# peer_scores: no judge_a this boot (see the boot log)",
    `csv_export   = "/api/events/${event.id}/export/scores.csv"`,
    "",
  ].join("\n");
}

export function writeCheckerFile(dir: string, contents: string): string {
  const file = path.join(dir, "checker-sessions.toml");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}
