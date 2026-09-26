import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

import { grantNamedAdmins } from "@/server/admins";
import { bootFixture } from "@/server/boot";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { signUp } from "@/server/dal/accounts";
import { healthCheck } from "@/server/dal/auth";

// Running the portal for a real event: the administrators come from ADMIN_EMAILS
// (at sign-up, or at the next start for an existing account, audited), and
// FIXTURES_PATH=none starts a portal without the sample event that still reports
// healthy.

const NOW = "2026-09-27T00:00:00.000Z";
let h: Handle;
const saved = { admins: process.env.ADMIN_EMAILS, fixtures: process.env.FIXTURES_PATH };

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  for (const [key, value] of [
    ["ADMIN_EMAILS", saved.admins],
    ["FIXTURES_PATH", saved.fixtures],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const isAdmin = (email: string) => (h.sqlite.prepare("SELECT is_admin AS a FROM users WHERE email = ?").get(email) as { a: number } | undefined)?.a;
const audits = (action: string) => (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;

describe("administrators for a real event", () => {
  it("an address in ADMIN_EMAILS signs up as an administrator, recorded in the audit row; any other address does not", async () => {
    process.env.ADMIN_EMAILS = "Chair@Example.org, second@example.org";
    await signUp({ name: "Chair", email: "chair@example.org", password: "a long enough password" });
    await signUp({ name: "Someone", email: "someone@example.org", password: "a long enough password" });
    expect(isAdmin("chair@example.org")).toBe(1);
    expect(isAdmin("someone@example.org")).toBe(0);
    const row = h.sqlite.prepare("SELECT after FROM audit_log WHERE action = 'user.sign_up' AND target_id = (SELECT id FROM users WHERE email = 'chair@example.org')").get() as { after: string };
    expect(JSON.parse(row.after)).toEqual({ isAdmin: true, by: "ADMIN_EMAILS" });
  });

  it("an existing account named in ADMIN_EMAILS becomes an administrator at the next start, once, audited", async () => {
    await signUp({ name: "Early", email: "early@example.org", password: "a long enough password" });
    expect(isAdmin("early@example.org")).toBe(0);
    process.env.ADMIN_EMAILS = "early@example.org";
    expect(grantNamedAdmins(h.db, NOW)).toEqual(["early@example.org"]);
    expect(isAdmin("early@example.org")).toBe(1);
    expect(audits("user.admin_granted")).toBe(1);
    expect(grantNamedAdmins(h.db, NOW)).toEqual([]); // nothing left to change
    expect(audits("user.admin_granted")).toBe(1);
  });

  it("known-bad: without ADMIN_EMAILS nobody is made an administrator", async () => {
    delete process.env.ADMIN_EMAILS;
    await signUp({ name: "Chair", email: "chair@example.org", password: "a long enough password" });
    expect(grantNamedAdmins(h.db, NOW)).toEqual([]);
    expect(isAdmin("chair@example.org")).toBe(0);
  });
});

describe("starting without the sample event", () => {
  it("FIXTURES_PATH=none imports nothing and still reports healthy", () => {
    process.env.FIXTURES_PATH = "none";
    expect(bootFixture(h, NOW)).toBeNull();
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM events").get() as { n: number }).n).toBe(0);
    expect(healthCheck()).toEqual({ ok: true, events: 0 });
  });

  it("known-bad: an empty portal without FIXTURES_PATH=none is not healthy yet (it has not been seeded)", () => {
    delete process.env.FIXTURES_PATH;
    expect(healthCheck()).toEqual({ ok: false, events: 0 });
  });

  it("by default the sample event is imported and the portal is healthy", () => {
    delete process.env.FIXTURES_PATH;
    expect(bootFixture(h, NOW)).toBe("evt_01");
    expect(healthCheck().ok).toBe(true);
  });
});
