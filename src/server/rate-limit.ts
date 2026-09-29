import "server-only";
import crypto from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { appendAudit } from "./audit";
import { DEFAULT_SEED_SECRET } from "./checker";
import { currentHandle, getDb, type Db } from "./db/client";
import { rateBuckets } from "./db/schema";
import { operatorCount } from "./settings";

// Token buckets in the database (rate_buckets), so a restart keeps them and every
// process on the same file shares them. Each key holds up to `capacity` tokens and
// regains them evenly over `perSeconds`. A key with no row has a full bucket, so rows
// idle for longer than the slowest refill are deleted as limits are taken.
//
// A key names whom it counts (an email address, a network address, an account id), so the
// table never stores it: each row's key is the limit's name, then an HMAC-SHA256 of the
// whole key under DOGFOOD_SEED_SECRET (storedKey). The same key always lands on the same
// row, so the limits work as before, and a copy of the database shows no email or address.

export type Limit = { capacity: number; perSeconds: number };

export const LIMITS = {
  /** ballot saves per voter */
  ballot: { capacity: 30, perSeconds: 60 },
  /**
   * unknown voting codes per network address (showing a link's page or entering with it):
   * guessing a personal or open link costs a try, and a real voter's code never does and
   * always goes through, even once the address is dry, so one person on a venue's shared
   * address cannot lock its voters out. Only unknown codes wait.
   */
  voteCodeMiss: { capacity: 30, perSeconds: 600 },
  /** new open-link voters per network address, per hour: the default; each event's organizer can set it (voting.ts) */
  linkVoter: { capacity: 8, perSeconds: 3600 },
  /**
   * comments per account: roomy enough for someone answering a busy thread (one every
   * 20 seconds for ten minutes), low enough that one account cannot bury a project page
   */
  comment: { capacity: 30, perSeconds: 600 },
  /** password sign-in attempts per email address from one network address */
  signIn: { capacity: 10, perSeconds: 900 },
  /**
   * password sign-in attempts per email address from anywhere: a ceiling on guessing
   * one account's password from many addresses. It is 10 times the per-address limit,
   * so a stranger at one address cannot lock the owner out; doing it from many
   * addresses takes 100 wrong tries within the hour.
   */
  signInAccount: { capacity: 100, perSeconds: 3600 },
  /**
   * sign-ups and password sign-ins together, per network address: each one costs an
   * argon2 hash, so this bounds what one address can make the server compute. A venue
   * puts everyone behind one address, so the default (300 per 10 minutes, one hash every
   * two seconds) lets a 100-person kickoff sign up and sign in twice over; the operator
   * sets SIGN_IN_LIMIT_PER_ADDRESS for a bigger one. Guessing one account's password
   * stays bounded by signIn and signInAccount, which do not change with it.
   */
  get accountAddress(): Limit {
    return { capacity: operatorCount("SIGN_IN_LIMIT_PER_ADDRESS"), perSeconds: 600 };
  },
  /**
   * refused requests per person (a signed-in account, or a voter holding a link): each
   * 403 writes an audit row, so past this the person is answered 429 and nothing is
   * written, and one account cannot fill the log. Far above what any honest use meets.
   */
  refusal: { capacity: 60, perSeconds: 600 },
} satisfies Record<string, Limit>;

/** after this long without a take, every bucket is full again */
const SLOWEST_REFILL_MS = Math.max(...Object.values(LIMITS).map((l) => l.perSeconds)) * 1000;

/**
 * What rate_buckets.key holds for a key: the limit's name (the part before the first colon, e.g. "signin") and an
 * HMAC-SHA256 of the whole key, keyed with DOGFOOD_SEED_SECRET like the voters' address hashes. The name keeps a row
 * readable to an operator ("a sign-in limit"); the hash keeps whom it counts out of the file.
 */
export function storedKey(key: string): string {
  const name = /^[a-z][a-z-]*(?=:)/.exec(key)?.[0] ?? "limit";
  const mac = crypto.createHmac("sha256", process.env.DOGFOOD_SEED_SECRET || DEFAULT_SEED_SECRET).update(`rate-limit:${key}`).digest("hex");
  return `${name}:${mac}`;
}

const STORED_KEY = /^[a-z][a-z-]*:[0-9a-f]{64}$/;

export type Take = { ok: true } | { ok: false; retryAfter: number; firstRefusal: boolean };

export function take(rawKey: string, limit: Limit, now = Date.now()): Take {
  const rate = limit.capacity / (limit.perSeconds * 1000);
  const key = storedKey(rawKey);
  return getDb().transaction((tx) => {
    tx.delete(rateBuckets).where(lt(rateBuckets.at, now - SLOWEST_REFILL_MS)).run();
    const row = tx.select().from(rateBuckets).where(eq(rateBuckets.key, key)).get();
    const b = row ? { tokens: row.tokens, at: row.at, refused: row.refused } : { tokens: limit.capacity, at: now, refused: false };
    b.tokens = Math.min(limit.capacity, b.tokens + Math.max(0, now - b.at) * rate);
    b.at = now;
    let result: Take;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      b.refused = false;
      result = { ok: true };
    } else {
      result = { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)), firstRefusal: !b.refused };
      b.refused = true;
    }
    tx.insert(rateBuckets).values({ key, ...b }).onConflictDoUpdate({ target: rateBuckets.key, set: b }).run();
    return result;
  });
}

/**
 * take(), and a key's first refusal writes one ratelimit.refused audit row: one when it
 * runs dry, not one per refused request, so hammering a limit cannot fill the log.
 */
export function takeAudited(key: string, limit: Limit, who: { userId: string | null; label: string; eventId?: string | null; what: string }): Take {
  const t = take(key, limit);
  if (!t.ok && t.firstRefusal) {
    getDb().transaction((tx) =>
      appendAudit(tx, {
        actorUserId: who.userId,
        actorLabel: who.label,
        action: "ratelimit.refused",
        eventId: who.eventId ?? null,
        targetType: "limit",
        targetId: who.what,
        after: { retryAfter: t.retryAfter },
      }),
    );
  }
  return t;
}

/**
 * Run at every start: delete the rows of buckets that are full again, and every row whose key is not a stored key
 * (a portal older than storedKey wrote keys such as signin:<email>:<address> as they were). Returns how many went.
 */
export function sweepRateBuckets(db: Db, now = Date.now()): number {
  return db.transaction((tx) => {
    let gone = tx.delete(rateBuckets).where(lt(rateBuckets.at, now - SLOWEST_REFILL_MS)).run().changes;
    for (const { key } of tx.select({ key: rateBuckets.key }).from(rateBuckets).all()) {
      if (!STORED_KEY.test(key)) gone += tx.delete(rateBuckets).where(eq(rateBuckets.key, key)).run().changes;
    }
    return gone;
  });
}

/** For tests: empty the buckets of the database in use, if one is open. */
export function resetRateLimits() {
  currentHandle()?.db.delete(rateBuckets).run();
}
