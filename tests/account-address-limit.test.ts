import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { LIMITS, resetRateLimits, take } from "@/server/rate-limit";
import { HttpError } from "@/server/errors";
import { settingsProblem } from "@/server/settings";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { signUp } = await import("@/server/dal/accounts");
const { signInWithPassword } = await import("@/server/dal/auth");

// Sign-up and password sign-in each cost an argon2 hash, so one network address
// gets a shared bucket of them (300 per 10 minutes by default, SIGN_IN_LIMIT_PER_ADDRESS
// to change it, roomy for a venue behind one address). A drained address is refused
// before any hashing; others are not.

const PASSWORD = "a long enough password";
const drained = { ip: "203.0.113.9", agent: "test" };
const other = { ip: "198.51.100.4", agent: "test" };
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  resetRateLimits();
  for (let i = 0; i < LIMITS.accountAddress.capacity; i++) expect(take(`account:${drained.ip}`, LIMITS.accountAddress).ok).toBe(true);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  resetRateLimits();
});

const users = () => (h.sqlite.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
const refusals = () => (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'ratelimit.refused' AND target_id = 'account-address'").get() as { n: number }).n;

describe("the per-address bucket for sign-up and sign-in", () => {
  it("a drained address is refused with 429 at sign-up, makes no account, and the first refusal is audited once", async () => {
    for (const email of ["a@example.org", "b@example.org"]) {
      let caught: unknown;
      try {
        await signUp({ name: "A", email, password: PASSWORD }, drained);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      expect((caught as HttpError).status).toBe(429);
    }
    expect(users()).toBe(0);
    expect(refusals()).toBe(1);
  });

  it("another address signs up as usual", async () => {
    await signUp({ name: "B", email: "b@example.org", password: PASSWORD }, other);
    expect(users()).toBe(1);
  });

  it("password sign-in from a drained address is refused with a wait; from another address it checks the password", async () => {
    await signUp({ name: "C", email: "c@example.org", password: PASSWORD }, other);
    const refused = await signInWithPassword("c@example.org", PASSWORD, drained);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? 0 : (refused.retryAfter ?? 0)).toBeGreaterThan(0);
    expect((await signInWithPassword("c@example.org", PASSWORD, other)).ok).toBe(true);
  });

  it("known-bad: without the bucket drained, the same address signs up", async () => {
    resetRateLimits();
    await signUp({ name: "D", email: "d@example.org", password: PASSWORD }, drained);
    expect(users()).toBe(1);
  });
});

describe("SIGN_IN_LIMIT_PER_ADDRESS", () => {
  const saved = process.env.SIGN_IN_LIMIT_PER_ADDRESS;
  afterEach(() => {
    if (saved === undefined) delete process.env.SIGN_IN_LIMIT_PER_ADDRESS;
    else process.env.SIGN_IN_LIMIT_PER_ADDRESS = saved;
  });

  it("defaults to 300 per 10 minutes: a 100-person kickoff on one address signs up and signs in", () => {
    delete process.env.SIGN_IN_LIMIT_PER_ADDRESS;
    expect(LIMITS.accountAddress).toEqual({ capacity: 300, perSeconds: 600 });
    resetRateLimits();
    const venue = "192.0.2.50";
    for (let i = 0; i < 300; i++) expect(take(`account:${venue}`, LIMITS.accountAddress).ok).toBe(true);
    expect(take(`account:${venue}`, LIMITS.accountAddress).ok).toBe(false);
  });

  it("the operator's value is the bucket: at 3, the fourth sign-up from one address is 429 and makes no account", async () => {
    process.env.SIGN_IN_LIMIT_PER_ADDRESS = "3";
    resetRateLimits();
    const venue = { ip: "192.0.2.51", agent: "test" };
    for (const n of [1, 2, 3]) await signUp({ name: `V${n}`, email: `v${n}@example.org`, password: PASSWORD }, venue);
    expect(users()).toBe(3);
    await expect(signUp({ name: "V4", email: "v4@example.org", password: PASSWORD }, venue)).rejects.toMatchObject({ status: 429 });
    expect(users()).toBe(3);
  });

  it("boot refuses a value that is not a whole number in range, and accepts a good one or none", () => {
    for (const bad of ["abc", "0", "1.5", "-4", "100001"]) expect(settingsProblem({ SIGN_IN_LIMIT_PER_ADDRESS: bad })).toMatch(/SIGN_IN_LIMIT_PER_ADDRESS must be a whole number/);
    expect(settingsProblem({ SIGN_IN_LIMIT_PER_ADDRESS: "1000" })).toBeNull();
    expect(settingsProblem({ SIGN_IN_LIMIT_PER_ADDRESS: "" })).toBeNull();
    expect(settingsProblem({})).toBeNull();
  });
});
