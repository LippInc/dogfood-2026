import "server-only";
import { and, eq, lte } from "drizzle-orm";
import { getDb, type Db } from "./db/client";
import { sessions } from "./db/schema";
import { sweepRateBuckets } from "./rate-limit";

// What the portal deletes by itself, so it keeps nothing it no longer uses: password sign-in
// sessions past their end (a session nobody can use any more still says who signed in and when),
// and rate-limit buckets idle for longer than their slowest refill. Run at every start and then
// every hour, so a quiet portal forgets them too; the rate limits also drop idle buckets as they
// are taken. What the portal keeps for good, and how an operator removes it, is in DATA-MODEL.md
// ("Privacy") and on the /privacy page.

export type Swept = { sessions: number; buckets: number };

export function sweepRetention(db: Db, now = new Date()): Swept {
  const ended = db
    .delete(sessions)
    .where(and(eq(sessions.kind, "login"), lte(sessions.expiresAt, now.toISOString())))
    .run().changes;
  return { sessions: ended, buckets: sweepRateBuckets(db, now.getTime()) };
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startRetentionSweeper(intervalMs = 3_600_000): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweepRetention(getDb());
    } catch (err) {
      console.error("[retention] sweep failed:", err);
    }
  }, intervalMs);
  timer.unref?.();
}
