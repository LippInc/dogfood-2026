import "server-only";
import { eq, lt } from "drizzle-orm";
import { appendAudit } from "./audit";
import { currentHandle, getDb } from "./db/client";
import { rateBuckets } from "./db/schema";

// Token buckets in the database (rate_buckets), so a restart keeps them and every
// process on the same file shares them. Each key holds up to `capacity` tokens and
// regains them evenly over `perSeconds`. A key with no row has a full bucket, so rows
// idle for longer than the slowest refill are deleted as limits are taken.

export type Limit = { capacity: number; perSeconds: number };

export const LIMITS = {
  /** ballot saves per voter */
  ballot: { capacity: 30, perSeconds: 60 },
  /** new open-link voters per network address */
  linkVoter: { capacity: 8, perSeconds: 3600 },
  /** comments per account */
  comment: { capacity: 5, perSeconds: 600 },
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
   * argon2 hash, so this bounds what one address can make the server compute. Roomy
   * enough for a venue where everyone shares one address.
   */
  accountAddress: { capacity: 60, perSeconds: 600 },
  /**
   * refused requests per person (a signed-in account, or a voter holding a link): each
   * 403 writes an audit row, so past this the person is answered 429 and nothing is
   * written, and one account cannot fill the log. Far above what any honest use meets.
   */
  refusal: { capacity: 60, perSeconds: 600 },
} satisfies Record<string, Limit>;

/** after this long without a take, every bucket is full again */
const SLOWEST_REFILL_MS = Math.max(...Object.values(LIMITS).map((l) => l.perSeconds)) * 1000;

export type Take = { ok: true } | { ok: false; retryAfter: number; firstRefusal: boolean };

export function take(key: string, limit: Limit, now = Date.now()): Take {
  const rate = limit.capacity / (limit.perSeconds * 1000);
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

/** For tests: empty the buckets of the database in use, if one is open. */
export function resetRateLimits() {
  currentHandle()?.db.delete(rateBuckets).run();
}
