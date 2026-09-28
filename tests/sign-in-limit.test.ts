import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { resetRateLimits } from "@/server/rate-limit";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { signInWithPassword } = await import("@/server/dal/auth");

let h: Handle;

// The buckets refill as the clock moves (the account-wide one regains a try every 36 s), and
// these tests run real argon2 checks, 101 in the last one: on a slow or busy machine that
// takes longer than 36 s and the 101st try gets through. The clock is held still, so the
// tests count tries whatever the machine's speed; argon2 itself runs for real.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-28T12:00:00.000Z") });
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
  setHandleForTests(null);
  h.sqlite.close();
});

const refusals = () => (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'ratelimit.refused'").get() as { n: number }).n;

describe("password sign-in is rate limited per email address and network address", () => {
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
  }, 30_000); // real argon2 checks; the full suite runs the pairwise Monte Carlo beside them

  it("known-bad: another address is not affected by the first one's limit", async () => {
    for (let i = 0; i < 11; i++) await signInWithPassword("target@example.org", `wrong-${i}`);
    const other = await signInWithPassword("someone-else@example.org", "wrong");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.message).toMatch(/do not match/);
  }, 30_000);

  it("a stranger at another network address cannot use up the owner's tries", async () => {
    const stranger = { ip: "203.0.113.50", agent: "test" };
    const owner = { ip: "198.51.100.7", agent: "test" };
    for (let i = 0; i < 12; i++) await signInWithPassword("target@example.org", `wrong-${i}`, stranger);
    const fromStranger = await signInWithPassword("target@example.org", "wrong-12", stranger);
    expect(fromStranger.ok).toBe(false);
    if (!fromStranger.ok) expect(fromStranger.message).toMatch(/from your network/);
    // The owner's own address still gets a real password check (known-bad: a limit keyed
    // on the email alone refuses this one).
    const fromOwner = await signInWithPassword("target@example.org", "still-wrong", owner);
    expect(fromOwner.ok).toBe(false);
    if (!fromOwner.ok) expect(fromOwner.message).toMatch(/do not match/);
  }, 30_000);

  it("from many addresses together, one email address gets at most 100 tries an hour", async () => {
    for (let a = 0; a < 10; a++) {
      const client = { ip: `192.0.2.${a + 1}`, agent: "test" };
      for (let i = 0; i < 10; i++) {
        const r = await signInWithPassword("target@example.org", `wrong-${a}-${i}`, client);
        if (!r.ok) expect(r.message).toMatch(/do not match/);
      }
    }
    const hundredFirst = await signInWithPassword("target@example.org", "wrong", { ip: "192.0.2.99", agent: "test" });
    expect(hundredFirst.ok).toBe(false);
    if (!hundredFirst.ok) expect(hundredFirst.message).toMatch(/several networks/);
    const other = await signInWithPassword("someone-else@example.org", "wrong", { ip: "192.0.2.99", agent: "test" });
    if (!other.ok) expect(other.message).toMatch(/do not match/);
  }, 60_000); // 101 real argon2 checks
});
