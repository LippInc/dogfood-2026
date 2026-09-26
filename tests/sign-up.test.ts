import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { signUp } from "@/server/dal/accounts";
import { verifyPassword } from "@/server/session";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // signUp goes through getDb()
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

async function expectHttpRejection(promise: Promise<unknown>, status: number, code: string): Promise<HttpError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to reject").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  return error;
}

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();
const loginSessions = (userId: string) =>
  (h.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE user_id = ? AND kind = 'login'").get(userId) as { n: number }).n;

const ADA = { name: "Ada", email: "ADA@Example.org ", password: "correct horse battery" };

describe("signUp", () => {
  it("creates the account lowercased and hashed, with no role, one audit row and one login session", async () => {
    const { userId } = await signUp(ADA);

    expect(userId.startsWith("usr_")).toBe(true);
    const u = h.sqlite
      .prepare("SELECT email, password_hash AS passwordHash, is_admin AS isAdmin FROM users WHERE id = ?")
      .get(userId) as { email: string; passwordHash: string; isAdmin: number };
    expect(u.email).toBe("ada@example.org");
    expect(u.passwordHash.startsWith("$argon2id$")).toBe(true);
    expect(u.isAdmin).toBe(0);
    expect(verifyPassword("correct horse battery", u.passwordHash)).toBe(true);
    expect(verifyPassword("wrong horse", u.passwordHash)).toBe(false);
    expect(
      (h.sqlite.prepare("SELECT count(*) AS n FROM user_roles WHERE user_id = ?").get(userId) as { n: number }).n,
    ).toBe(0); // an account has no role of its own

    const signUps = auditRows().filter((r) => r.action === "user.sign_up");
    expect(signUps).toHaveLength(1);
    expect(signUps[0]!.targetId).toBe(userId);
    expect(loginSessions(userId)).toBe(1);
  });

  it("refuses the same email again, in any case, with 409 email_taken", async () => {
    await signUp(ADA);
    await expectHttpRejection(
      signUp({ name: "Ada Again", email: "ada@EXAMPLE.org", password: "another long one" }),
      409,
      "email_taken",
    );
    expect(count("SELECT count(*) AS n FROM users WHERE email = 'ada@example.org'")).toBe(1);
  });

  it("known-bad: a short password, a missing name and a non-email are each 422 and create nothing", async () => {
    const usersBefore = count("SELECT count(*) AS n FROM users");

    await expectHttpRejection(signUp({ name: "Bo", email: "bo@example.org", password: "short" }), 422, "invalid");
    await expectHttpRejection(signUp({ email: "bo@example.org", password: "long enough pass" }), 422, "invalid");
    await expectHttpRejection(signUp({ name: "Bo", email: "not-an-email", password: "long enough pass" }), 422, "invalid");

    expect(count("SELECT count(*) AS n FROM users")).toBe(usersBefore);
    expect(count("SELECT count(*) AS n FROM sessions")).toBe(0);
  });

  it("refuses an imported fixture email with 409: an existing person cannot be claimed by signing up", async () => {
    await expectHttpRejection(
      signUp({ name: "Priya", email: "priya1@example.org", password: "long enough pass" }), // first member of tm_01
      409,
      "email_taken",
    );
  });
});
