import "server-only";

// Token buckets in memory: the portal runs as one process, so one Map is the whole
// state, and a restart forgets it (a limit, not a ledger). Each key holds up to
// `capacity` tokens and regains them evenly over `perSeconds`.

export type Limit = { capacity: number; perSeconds: number };

export const LIMITS = {
  /** ballot saves per voter */
  ballot: { capacity: 30, perSeconds: 60 },
  /** new open-link voters per network address */
  linkVoter: { capacity: 8, perSeconds: 3600 },
  /** comments per account */
  comment: { capacity: 5, perSeconds: 600 },
  /** password sign-in attempts per email address */
  signIn: { capacity: 10, perSeconds: 900 },
  /**
   * sign-ups and password sign-ins together, per network address: each one costs an
   * argon2 hash, so this bounds what one address can make the server compute. Roomy
   * enough for a venue where everyone shares one address.
   */
  accountAddress: { capacity: 60, perSeconds: 600 },
} satisfies Record<string, Limit>;

type Bucket = { tokens: number; at: number; refused: boolean };
const buckets = new Map<string, Bucket>();

export type Take = { ok: true } | { ok: false; retryAfter: number; firstRefusal: boolean };

export function take(key: string, limit: Limit, now = Date.now()): Take {
  const rate = limit.capacity / (limit.perSeconds * 1000);
  const b = buckets.get(key) ?? { tokens: limit.capacity, at: now, refused: false };
  b.tokens = Math.min(limit.capacity, b.tokens + (now - b.at) * rate);
  b.at = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    b.refused = false;
    buckets.set(key, b);
    return { ok: true };
  }
  const firstRefusal = !b.refused;
  b.refused = true;
  buckets.set(key, b);
  return { ok: false, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)), firstRefusal };
}

/** For tests. */
export function resetRateLimits() {
  buckets.clear();
}
