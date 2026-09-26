import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

import { openAdminSetup, setupCodeValid } from "@/server/admins";
import { bootFixture } from "@/server/boot";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { HttpError } from "@/server/errors";
import { signUp } from "@/server/dal/accounts";
import { healthCheck } from "@/server/dal/auth";

// Running the portal for a real event. The administrator is named in ADMIN_EMAILS,
// but accounts are not email-verified, so signing up with that address needs the
// one-time setup code the portal prints in its log at start; anyone else trying the
// address is refused. FIXTURES_PATH=none starts a portal without the sample event
// that still reports healthy.

const NOW = "2026-09-27T00:00:00.000Z";
const PASSWORD = "a long enough password";
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

async function refused(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected a refusal");
}

describe("the administrator of a real event", () => {
  it("signs up with the address in ADMIN_EMAILS and the setup code from the log, and the audit row says so", async () => {
    process.env.ADMIN_EMAILS = "Chair@Example.org";
    const setup = openAdminSetup(h.db)!;
    expect(setup.waiting).toEqual(["chair@example.org"]);
    await signUp({ name: "Chair", email: "chair@example.org", password: PASSWORD, setup: setup.code });
    expect(isAdmin("chair@example.org")).toBe(1);
    const row = h.sqlite.prepare("SELECT after FROM audit_log WHERE action = 'user.sign_up'").get() as { after: string };
    expect(JSON.parse(row.after)).toEqual({ isAdmin: true, by: "ADMIN_EMAILS" });
    // once every named address has an account there is nothing left to set up
    expect(openAdminSetup(h.db)).toBeNull();
    expect(setupCodeValid(setup.code)).toBe(false);
  });

  it("known-bad: someone else taking the named address first is refused with 403, without the code or with a wrong one", async () => {
    process.env.ADMIN_EMAILS = "chair@example.org";
    openAdminSetup(h.db);
    const bare = await refused(signUp({ name: "Mallory", email: "chair@example.org", password: PASSWORD }));
    expect([bare.status, bare.code]).toEqual([403, "admin_setup_required"]);
    const guessed = await refused(signUp({ name: "Mallory", email: "chair@example.org", password: PASSWORD, setup: "guess" }));
    expect(guessed.status).toBe(403);
    expect(isAdmin("chair@example.org")).toBeUndefined(); // no account was made
  });

  it("the code makes no one else an administrator, and ordinary sign-up is untouched", async () => {
    process.env.ADMIN_EMAILS = "chair@example.org";
    const setup = openAdminSetup(h.db)!;
    await signUp({ name: "Someone", email: "someone@example.org", password: PASSWORD, setup: setup.code });
    await signUp({ name: "Other", email: "other@example.org", password: PASSWORD });
    expect(isAdmin("someone@example.org")).toBe(0);
    expect(isAdmin("other@example.org")).toBe(0);
  });

  it("known-bad: an existing account named later is not promoted, and a restart makes a new code", async () => {
    await signUp({ name: "Early", email: "early@example.org", password: PASSWORD });
    process.env.ADMIN_EMAILS = "early@example.org, chair@example.org";
    const first = openAdminSetup(h.db)!;
    expect(first.waiting).toEqual(["chair@example.org"]);
    expect(isAdmin("early@example.org")).toBe(0);
    const second = openAdminSetup(h.db)!;
    expect(second.code).not.toBe(first.code);
    expect(setupCodeValid(first.code)).toBe(false);
    expect(setupCodeValid(second.code)).toBe(true);
  });

  it("without ADMIN_EMAILS there is no setup and no code works", () => {
    delete process.env.ADMIN_EMAILS;
    expect(openAdminSetup(h.db)).toBeNull();
    expect(setupCodeValid("anything")).toBe(false);
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
