import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, useHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRateLimits } from "@/server/rate-limit";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { signInWithPassword } = await import("@/server/dal/auth");

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  useHandleForTests(h);
  resetRateLimits();
});

afterEach(() => {
  useHandleForTests(null);
  h.sqlite.close();
});

const refusals = () => (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'ratelimit.refused'").get() as { n: number }).n;

describe("password sign-in is rate limited per email address", () => {
  it("answers ten wrong guesses with the plain refusal, then refuses the eleventh as too many, audited once", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await signInWithPassword("Target@Example.org", `wrong-${i}`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/do not match/);
    }
    const eleventh = await signInWithPassword("target@example.org", "wrong-10");
    expect(eleventh.ok).toBe(false);
    if (!eleventh.ok) expect(eleventh.message).toMatch(/Too many attempts/);
    await signInWithPassword("target@example.org", "wrong-11");
    expect(refusals()).toBe(1);
  });

  it("known-bad: another address is not affected by the first one's limit", async () => {
    for (let i = 0; i < 11; i++) await signInWithPassword("target@example.org", `wrong-${i}`);
    const other = await signInWithPassword("someone-else@example.org", "wrong");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.message).toMatch(/do not match/);
  });
});
