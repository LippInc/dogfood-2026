import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { DEMO_ORGANIZER, ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { sha256 } from "@/server/util";
import type { Actor } from "@/server/authz";

// resetPassword sets the session cookie
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { createLoginSession, hashPassword, verifyPassword } = await import("@/server/session");
const { makePasswordReset, describePasswordReset, resetPassword, guardAccounts } = await import("@/server/dal/password-resets");
const { getPortalLog } = await import("@/server/dal/audit-log");

const NOW = "2026-09-26T12:00:00.000Z";
const EVENT = "evt_01";
const NEVER = "2100-01-01T00:00:00.000Z";
const OLD_PASSWORD = "old password 123";
const NEW_PASSWORD = "a brand new password";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha256, now: NOW });
  ensureDemoOrganizer(h.db, EVENT, NOW); // makes usr_organizer an admin (is_admin = 1) and organizer of evt_01
  const addUser = h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  addUser.run("usr_admin", "admin@example.org", "Ada Admin", null, 1, NOW);
  addUser.run("usr_plain", "plain@example.org", "Pat Plain", null, 0, NOW);
  addUser.run("usr_target", "target@example.org", "Tara Target", hashPassword(OLD_PASSWORD), 0, NOW);
  addUser.run("usr_other", "other@example.org", "Owen Other", null, 0, NOW);
  createLoginSession(h.db, "usr_target"); // two signed-in browsers for Tara...
  createLoginSession(h.db, "usr_target");
  createLoginSession(h.db, "usr_other"); // ...and someone else's, which must survive
  setHandleForTests(h);
  resetRateLimits();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

async function expectHttpErrorAsync(call: () => Promise<unknown>, status: number, code: string) {
  let caught: unknown;
  try {
    await call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
}

const nOf = (sql: string, ...params: (string | number)[]) => (h.sqlite.prepare(sql).get(...params) as { n: number }).n;
const one = <T>(sql: string, ...params: (string | number)[]) => h.sqlite.prepare(sql).get(...params) as T;
const resets = () => nOf("SELECT count(*) AS n FROM password_resets");
const loginSessions = (userId: string) => nOf("SELECT count(*) AS n FROM sessions WHERE user_id = ? AND kind = 'login'", userId);
const storedHash = () => one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = 'usr_target'").password_hash;
const tokenOf = (link: { path: string }) => link.path.slice("/reset/".length);

/** An actor as the session layer would build it, with the admin flag read from the row. */
function actorIn(userId: string): Actor {
  const u = one<{ id: string; name: string; email: string; isAdmin: number }>(
    "SELECT id, name, email, is_admin AS isAdmin FROM users WHERE id = ?",
    userId,
  );
  if (!u) throw new Error(`no user row for ${userId}`);
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin === 1, roles: [], sessionKind: "login" };
}

describe("password reset links", () => {
  it("making a link and the Accounts gate are for administrators only; only the token's digest is stored", () => {
    const admin = actorIn("usr_admin");
    const plain = actorIn("usr_plain");

    expectHttpError(() => makePasswordReset(null, { email: "target@example.org" }), 401, "unauthenticated");
    expectHttpError(() => guardAccounts(null), 401, "unauthenticated");
    expectHttpError(() => makePasswordReset(plain, { email: "target@example.org" }), 403, "not_an_admin");
    expectHttpError(() => guardAccounts(plain), 403, "not_an_admin");

    expect(() => guardAccounts(admin)).not.toThrow(); // positive control: the gate lets an administrator through

    const before = Date.now();
    const link = makePasswordReset(admin, { email: "target@example.org" });
    const after = Date.now();

    expect(link.email).toBe("target@example.org");
    expect(link.name).toBe("Tara Target");
    expect(link.path).toMatch(/^\/reset\/[A-Za-z0-9]{32}$/); // newSecret(24) is 32 letters and digits
    expect(Date.parse(link.expiresAt)).toBeGreaterThanOrEqual(before + 24 * 3_600_000); // a day from the call
    expect(Date.parse(link.expiresAt)).toBeLessThanOrEqual(after + 24 * 3_600_000);

    const row = one<{ token_hash: string; user_id: string; used_at: string | null }>(
      "SELECT token_hash, user_id, used_at FROM password_resets",
    );
    expect(resets()).toBe(1);
    expect(row.token_hash).toBe(sha256(tokenOf(link))); // the digest, never the token itself
    expect(row.token_hash).not.toBe(tokenOf(link));
    expect(row.user_id).toBe("usr_target");
    expect(row.used_at).toBeNull();
  });

  it("an administrator's API token cannot make a link (it would end in a full sign-in); the same administrator signed in can", () => {
    const viaToken: Actor = { ...actorIn("usr_admin"), sessionKind: "api" };
    expectHttpError(() => makePasswordReset(viaToken, { email: "admin@example.org" }), 403, "token_cannot_reset_passwords");
    expectHttpError(() => makePasswordReset(viaToken, { email: "target@example.org" }), 403, "token_cannot_reset_passwords");
    expect(resets()).toBe(0);
    expect(() => guardAccounts(viaToken)).not.toThrow(); // reading the Accounts gate is not a write
    expect(makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" }).path).toMatch(/^\/reset\//); // positive control
  });

  it("the email is trimmed and lowercased before the lookup; an unknown address is a 404 that inserts nothing", () => {
    const admin = actorIn("usr_admin");

    const link = makePasswordReset(admin, { email: "  TARGET@example.org " });
    expect(link.email).toBe("target@example.org");
    expect(link.name).toBe("Tara Target");
    expect(one<{ user_id: string }>("SELECT user_id FROM password_resets").user_id).toBe("usr_target");

    expectHttpError(() => makePasswordReset(admin, { email: "nobody@example.org" }), 404, "not_found");
    expect(resets()).toBe(1); // only the row from the successful lookup above
  });

  it("demo accounts are refused with 409 demo_account and get no link", () => {
    const admin = actorIn("usr_admin");
    // usr_other signs in as a checker identity, so it is a demo account too
    h.sqlite
      .prepare("INSERT INTO sessions (token_hash, user_id, kind, label, created_at, expires_at) VALUES (?, ?, 'checker', ?, ?, ?)")
      .run("sess_checker_other", "usr_other", "checker:usr_other", NOW, NEVER);

    expectHttpError(() => makePasswordReset(admin, { email: DEMO_ORGANIZER.email }), 409, "demo_account");
    expectHttpError(() => makePasswordReset(admin, { email: "other@example.org" }), 409, "demo_account");
    expect(resets()).toBe(0);

    // positive control: an ordinary account still gets one
    expect(makePasswordReset(admin, { email: "target@example.org" }).path.startsWith("/reset/")).toBe(true);
    expect(resets()).toBe(1);
  });

  it("describePasswordReset says whose link it is; an unknown token is a 404", () => {
    const link = makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" });

    expect(describePasswordReset(tokenOf(link))).toEqual({ email: "target@example.org", name: "Tara Target" });
    expectHttpError(() => describePasswordReset("no-such-token"), 404, "not_found");
  });

  it("setting the password works once, ends the account's other sessions and leaves everyone else's alone", async () => {
    const link = makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" });
    const token = tokenOf(link);

    const out = await resetPassword(token, { password: NEW_PASSWORD });
    expect(out).toEqual({ userId: "usr_target", sessionsEnded: 2 });

    expect(verifyPassword(NEW_PASSWORD, storedHash())).toBe(true);
    expect(verifyPassword(OLD_PASSWORD, storedHash())).toBe(false); // the old password stops working

    expect(loginSessions("usr_target")).toBe(1); // exactly the one the reset just created
    expect(loginSessions("usr_other")).toBe(1); // another person's session is untouched

    await expectHttpErrorAsync(() => resetPassword(token, { password: "another password 1" }), 410, "reset_used");
    expectHttpError(() => describePasswordReset(token), 410, "reset_used");
  });

  it("an expired link answers 410 reset_expired and changes nothing", async () => {
    const link = makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" });
    const token = tokenOf(link);
    // both move together: the table checks that expires_at is after created_at
    h.sqlite.prepare("UPDATE password_resets SET created_at = ?, expires_at = ?").run("2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");

    expectHttpError(() => describePasswordReset(token), 410, "reset_expired");
    await expectHttpErrorAsync(() => resetPassword(token, { password: NEW_PASSWORD }), 410, "reset_expired");

    expect(verifyPassword(OLD_PASSWORD, storedHash())).toBe(true); // the password is unchanged
    expect(verifyPassword(NEW_PASSWORD, storedHash())).toBe(false);
    expect(loginSessions("usr_target")).toBe(2); // both sessions survive
  });

  it("a second link for the same account replaces the unused first one", async () => {
    const admin = actorIn("usr_admin");
    const first = makePasswordReset(admin, { email: "target@example.org" });
    const second = makePasswordReset(admin, { email: "target@example.org" });

    expect(resets()).toBe(1);
    expectHttpError(() => describePasswordReset(tokenOf(first)), 404, "not_found"); // the first token is gone

    const out = await resetPassword(tokenOf(second), { password: NEW_PASSWORD });
    expect(out).toEqual({ userId: "usr_target", sessionsEnded: 2 });
  });

  it("a password under 10 characters is a 422 and leaves the link unused", async () => {
    const link = makePasswordReset(actorIn("usr_admin"), { email: "target@example.org" });
    const token = tokenOf(link);

    await expectHttpErrorAsync(() => resetPassword(token, { password: "short" }), 422, "invalid");

    expect(one<{ used_at: string | null }>("SELECT used_at FROM password_resets").used_at).toBeNull();
    expect(describePasswordReset(token)).toEqual({ email: "target@example.org", name: "Tara Target" });
  });

  it("the link and the reset are audited, in sentences and in a chain that verifies", async () => {
    const admin = actorIn("usr_admin");
    const link = makePasswordReset(admin, { email: "target@example.org" });
    await resetPassword(tokenOf(link), { password: NEW_PASSWORD });

    const rows = h.db.select().from(auditLog).orderBy(auditLog.id).all();
    const linkRow = rows.find((r) => r.action === "user.reset_link");
    const resetRow = rows.find((r) => r.action === "user.password_reset");
    if (!linkRow || !resetRow) throw new Error("the reset's audit rows are missing");

    expect(linkRow.actorUserId).toBe("usr_admin");
    expect(linkRow.targetId).toBe("usr_target");
    expect(linkRow.eventId).toBeNull();
    expect(linkRow.after).toEqual({ expiresAt: link.expiresAt });
    expect(resetRow.actorUserId).toBe("usr_target");
    expect(resetRow.targetId).toBe("usr_target");
    expect(resetRow.eventId).toBeNull();
    expect(resetRow.after).toEqual({ sessionsEnded: 2 });

    const sentences = getPortalLog(admin).lines.map((l) => l.parts.map((p) => p.text).join(""));
    expect(sentences.some((s) => s.includes("made a one-time link for"))).toBe(true);
    expect(sentences.some((s) => s.includes("which signed out 2 sessions"))).toBe(true);

    expect(verifyAuditChain(h.db).ok).toBe(true);
  });
});
