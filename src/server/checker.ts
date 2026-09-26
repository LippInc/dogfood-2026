import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { assignments, judgeTracks, sessions, teamMembers, teams, userRoles, users } from "./db/schema";
import { appendAudit } from "./audit";
import { sha256 } from "./util";

// Deterministic checker sessions (BUILD-PLAN decision 5). The acceptance checker
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
  return process.env.SEED_CHECKER_SESSIONS === "true";
}

/** Plain letters and digits, so both TOML parsers in run.py read it the same way. */
export function checkerToken(label: CheckerLabel, secret = process.env.DOGFOOD_SEED_SECRET || DEFAULT_SEED_SECRET): string {
  const mac = crypto.createHmac("sha256", secret).update(`dogfood-checker-session:${label}`).digest("hex");
  return `${PREFIX[label]}${mac.slice(0, 32)}`;
}

export type CheckerIdentity = { label: CheckerLabel; userId: string; name: string; token: string };

/**
 * Pick the four identities from what is in the database, the same way every boot:
 * judge_a is the judge with the most reviews (ties: lowest id), judge_b the judge
 * with the most reviews among those sharing a track with judge_a, and the
 * participant is the first member of the first team who holds no judge role.
 */
export function chooseCheckerUsers(db: Db, eventId: string): Record<CheckerLabel, string> {
  const load = db
    .select({ judge: assignments.judgeUserId, n: sql<number>`count(*)` })
    .from(assignments)
    .where(eq(assignments.eventId, eventId))
    .groupBy(assignments.judgeUserId)
    .orderBy(desc(sql`count(*)`), assignments.judgeUserId)
    .all();
  if (load.length === 0) throw new Error("checker sessions: the event has no judge with a review");
  const judgeA = load[0].judge;

  const tracksOf = (judge: string) =>
    new Set(
      db
        .select({ t: judgeTracks.trackId })
        .from(judgeTracks)
        .where(and(eq(judgeTracks.judgeUserId, judge), eq(judgeTracks.eventId, eventId)))
        .all()
        .map((r) => r.t),
    );
  const aTracks = tracksOf(judgeA);
  const judgeB = load.find((r) => r.judge !== judgeA && [...tracksOf(r.judge)].some((t) => aTracks.has(t)))?.judge;
  if (!judgeB) throw new Error("checker sessions: no second judge shares a track with judge_a");

  const judges = new Set(
    db
      .select({ u: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.eventId, eventId), eq(userRoles.role, "judge")))
      .all()
      .map((r) => r.u),
  );
  const members = db
    .select({ userId: teamMembers.userId, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.eventId, eventId))
    .orderBy(teams.id, sql`${teamMembers.role} = 'member'`, teamMembers.joinedAt, teamMembers.userId)
    .all();
  const participant = members.find((m) => !judges.has(m.userId))?.userId;
  if (!participant) throw new Error("checker sessions: no team member without a judge role");

  return { organizer: DEMO_ORGANIZER.id, judge_a: judgeA, judge_b: judgeB, participant };
}

/** Create the demo organizer (admin, organizer of the event). Idempotent. */
export function ensureDemoOrganizer(db: Db, eventId: string, now: string): void {
  db.insert(users)
    .values({ ...DEMO_ORGANIZER, passwordHash: null, isAdmin: true, createdAt: now })
    .onConflictDoNothing()
    .run();
  db.insert(userRoles)
    .values({ userId: DEMO_ORGANIZER.id, eventId, role: "organizer", createdAt: now })
    .onConflictDoNothing()
    .run();
}

export type CheckerSeedResult =
  | { enabled: true; identities: CheckerIdentity[]; changed: CheckerLabel[] }
  | { enabled: false; removed: number };

/** Upsert (or, when disabled, remove) the four checker sessions. Synchronous. */
export function seedCheckerSessions(db: Db, eventId: string, now: string): CheckerSeedResult {
  return db.transaction((tx) => {
    if (!checkerSessionsEnabled()) {
      const removed = tx.delete(sessions).where(eq(sessions.kind, "checker")).run().changes;
      if (removed > 0) {
        appendAudit(tx, { actorUserId: null, actorLabel: "system", action: "checker_sessions.removed", after: { removed } }, now);
      }
      return { enabled: false as const, removed };
    }
    const chosen = chooseCheckerUsers(tx as unknown as Db, eventId);
    const identities: CheckerIdentity[] = [];
    const changed: CheckerLabel[] = [];
    for (const label of CHECKER_LABELS) {
      const token = checkerToken(label);
      const tokenHash = sha256(token);
      const userId = chosen[label];
      const before = tx.select().from(sessions).where(eq(sessions.label, label)).get();
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
          after: Object.fromEntries(identities.map((i) => [i.label, i.userId])),
        },
        now,
      );
    }
    return { enabled: true as const, identities, changed };
  });
}

/** The [auth] and [routes] blocks of .dogfood.toml, ready to paste. */
export function checkerToml(identities: CheckerIdentity[], event: { id: string; slug: string }): string {
  const judgeA = identities.find((i) => i.label === "judge_a")!;
  const pad = (s: string) => s.padEnd(11);
  return [
    "[auth]",
    ...identities.map((i) => `${pad(i.label)} = "Cookie: session=${i.token}"`),
    "",
    "[routes]",
    `gallery      = "/events/${event.slug}"`,
    `submit       = "/api/events/${event.id}/projects"`,
    `judge_scores = "/api/judge/scores"`,
    `peer_scores  = "/api/judge/scores?judge=${judgeA.userId}"`,
    `csv_export   = "/api/events/${event.id}/export/scores.csv"`,
    "",
  ].join("\n");
}

export function writeCheckerFile(dir: string, contents: string): string {
  const file = path.join(dir, "checker-sessions.toml");
  fs.writeFileSync(file, contents, "utf8");
  return file;
}
