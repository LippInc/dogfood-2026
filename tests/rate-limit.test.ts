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

  it("refills with time, and deletes the rows of buckets that are full again", async () => {
    const { take, LIMITS } = await start();
    const t0 = Date.now();
    take("a", LIMIT, t0);
    take("a", LIMIT, t0);
    expect(take("a", LIMIT, t0).ok).toBe(false);
    expect(take("a", LIMIT, t0 + 30_000).ok).toBe(true); // one token back after half the refill time
    expect(h!.sqlite.prepare("SELECT key FROM rate_buckets").all()).toEqual([{ key: "a" }]);

    const slowest = Math.max(...Object.values(LIMITS).map((l) => l.perSeconds)) * 1000;
    take("b", LIMIT, t0 + 30_000 + slowest + 1);
    expect(h!.sqlite.prepare("SELECT key FROM rate_buckets").all()).toEqual([{ key: "b" }]);
  });
});
