import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { sweepRetention } from "@/server/retention";
import { storedKey } from "@/server/rate-limit";

// What the portal deletes by itself: ended password sign-ins and idle rate-limit buckets. The
// checker sessions (kind 'checker') never end and are never swept; a live sign-in stays.

let h: Handle;
const NOW = new Date("2026-09-29T12:00:00.000Z");

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  h.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_a', 'a@example.org', 'A', NULL, 0, ?)")
    .run(NOW.toISOString());
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function session(hash: string, kind: "login" | "checker", expiresAt: string) {
  h.sqlite
    .prepare("INSERT INTO sessions (token_hash, user_id, kind, label, created_at, expires_at) VALUES (?, 'usr_a', ?, ?, ?, ?)")
    .run(hash, kind, kind === "checker" ? `label_${hash}` : null, "2026-09-01T00:00:00.000Z", expiresAt);
}

const hashes = (table: string, column: string) =>
  (h.sqlite.prepare(`SELECT ${column} AS v FROM ${table} ORDER BY ${column}`).all() as { v: string }[]).map((r) => r.v);

describe("sweepRetention", () => {
  it("deletes ended sign-in sessions and idle buckets; keeps live sessions, checker sessions and busy buckets", () => {
    session("ended", "login", "2026-09-29T11:59:59.000Z");
    session("ends_now", "login", NOW.toISOString());
    session("live", "login", "2026-10-10T00:00:00.000Z");
    session("checker", "checker", "2026-09-01T00:00:00.000Z"); // an old checker row is left to the seed, not the sweep
    const busy = storedKey("comment:usr_a");
    h.sqlite.prepare("INSERT INTO rate_buckets (key, tokens, at, refused) VALUES (?, 1, ?, 0)").run(busy, NOW.getTime() - 60_000);
    h.sqlite.prepare("INSERT INTO rate_buckets (key, tokens, at, refused) VALUES (?, 1, ?, 0)").run(storedKey("comment:usr_b"), NOW.getTime() - 2 * 3_600_000);

    expect(sweepRetention(h.db, NOW)).toEqual({ sessions: 2, buckets: 1 });
    expect(hashes("sessions", "token_hash")).toEqual(["checker", "live"]);
    expect(hashes("rate_buckets", "key")).toEqual([busy]);

    expect(sweepRetention(h.db, NOW)).toEqual({ sessions: 0, buckets: 0 }); // nothing left to remove
  });
});
