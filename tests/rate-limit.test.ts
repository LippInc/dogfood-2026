import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Handle } from "@/server/db/client";

// The limits live in the database (rate_buckets): a restarted process still refuses a
// drained key, and the rows of buckets that have filled up again are deleted as limits
// are taken, so the table does not grow without bound.

const LIMIT = { capacity: 2, perSeconds: 60 };
let dir: string;
let h: Handle | null = null;

/** A process start: fresh modules and a fresh connection to the same database file. */
async function start() {
  if (h) h.sqlite.close();
  vi.resetModules();
  const client = await import("@/server/db/client");
  const { runMigrations } = await import("@/server/db/migrate");
  h = client.openDatabase(path.join(dir, "portal.db"));
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  client.setHandleForTests(h);
  return import("@/server/rate-limit");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "limits-"));
});

afterEach(() => {
  h?.sqlite.close();
  h = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("rate limits in the database", () => {
  it("a restarted process still refuses a drained key (known-bad: a limiter in module memory forgets it)", async () => {
    const now = Date.now();
    const first = await start();
    expect(first.take("k", LIMIT, now).ok).toBe(true);
    expect(first.take("k", LIMIT, now).ok).toBe(true);
    expect(first.take("k", LIMIT, now)).toMatchObject({ ok: false, firstRefusal: true });

    const second = await start();
    expect(second.take("k", LIMIT, now + 1000)).toMatchObject({ ok: false, firstRefusal: false });
    expect(second.take("other", LIMIT, now + 1000).ok).toBe(true);
  });

  it("takeAudited: a key's first refusal writes one ratelimit.refused row, later refusals none, takes that go through none", async () => {
    const { takeAudited } = await start();
    const who = { userId: null, label: "anonymous", what: "test-limit" };
    const rows = () =>
      h!.sqlite.prepare("SELECT actor_label AS label, event_id AS eventId, target_id AS target FROM audit_log WHERE action = 'ratelimit.refused'").all();
    expect([takeAudited("k", LIMIT, who).ok, takeAudited("k", LIMIT, who).ok]).toEqual([true, true]);
    expect(rows()).toEqual([]);
    expect([takeAudited("k", LIMIT, who).ok, takeAudited("k", LIMIT, who).ok, takeAudited("k", LIMIT, who).ok]).toEqual([false, false, false]);
    expect(rows()).toEqual([{ label: "anonymous", eventId: null, target: "test-limit" }]);
  });

  it("refills with time, and deletes the rows of buckets that are full again", async () => {
    const { take, LIMITS, storedKey } = await start();
    const t0 = Date.now();
    take("a", LIMIT, t0);
    take("a", LIMIT, t0);
    expect(take("a", LIMIT, t0).ok).toBe(false);
    expect(take("a", LIMIT, t0 + 30_000).ok).toBe(true); // one token back after half the refill time
    expect(h!.sqlite.prepare("SELECT key FROM rate_buckets").all()).toEqual([{ key: storedKey("a") }]);

    const slowest = Math.max(...Object.values(LIMITS).map((l) => l.perSeconds)) * 1000;
    take("b", LIMIT, t0 + 30_000 + slowest + 1);
    expect(h!.sqlite.prepare("SELECT key FROM rate_buckets").all()).toEqual([{ key: storedKey("b") }]);
  });

  it("stores each key as the limit's name and a keyed hash: same key, same row; another secret, another hash", async () => {
    const { take, storedKey } = await start();
    const key = "signin:someone@example.org:192.0.2.1";
    const now = Date.now();
    expect(take(key, LIMIT, now).ok).toBe(true);
    expect(take(key, LIMIT, now).ok).toBe(true);
    expect(take(key, LIMIT, now).ok).toBe(false); // one row counts both takes
    const rows = h!.sqlite.prepare("SELECT key FROM rate_buckets").all() as { key: string }[];
    expect(rows).toEqual([{ key: storedKey(key) }]);
    expect(rows[0]!.key).toMatch(/^signin:[0-9a-f]{64}$/);
    expect(storedKey("no colon here")).toMatch(/^limit:[0-9a-f]{64}$/);
    const before = storedKey(key);
    vi.stubEnv("DOGFOOD_SEED_SECRET", "another-secret-for-this-test");
    try {
      expect(storedKey(key)).not.toBe(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sweepRateBuckets, at every start: removes idle buckets and rows an older portal keyed in the clear; keeps live hashed ones", async () => {
    const { take, storedKey, sweepRateBuckets } = await start();
    const now = Date.now();
    take("comment:usr_live", LIMIT, now);
    h!.sqlite.prepare("INSERT INTO rate_buckets (key, tokens, at, refused) VALUES (?, 1, ?, 0)").run("signin:old@example.org:192.0.2.9", now);
    h!.sqlite.prepare("INSERT INTO rate_buckets (key, tokens, at, refused) VALUES (?, 1, ?, 0)").run(storedKey("comment:usr_idle"), now - 2 * 3600 * 1000);
    expect(sweepRateBuckets(h!.db, now)).toBe(2);
    expect(h!.sqlite.prepare("SELECT key FROM rate_buckets").all()).toEqual([{ key: storedKey("comment:usr_live") }]);
  });
});
