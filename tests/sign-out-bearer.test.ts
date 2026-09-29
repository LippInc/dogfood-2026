import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { sessions } from "@/server/db/schema";
import { sha256 } from "@/server/util";
import type { Actor } from "@/server/authz";

// Sign-out used to read only the session cookie, yet answered every API client { signedOut: true }: a script
// signed in with Authorization: Bearer <session token> was told it had signed out while its session stayed live,
// and so was one sending an API token. Now a Bearer login session ends like a cookie one; an API token is not a
// session and is not ended by sign-out (the answer says signedOut: false and why); the four checker sessions are
// never ended, whichever way they arrive, and the answer says so. Each case is proven by the next /me call.

const jar = { cookie: undefined as string | undefined };
let requestHeaders = new Headers();
const cookieDelete = vi.fn((name: string) => {
  if (name === "session") jar.cookie = undefined;
});
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: (name: string) => (name === "session" && jar.cookie ? { name, value: jar.cookie } : undefined), delete: cookieDelete }),
  headers: async () => requestHeaders,
}));

const { POST } = await import("@/app/api/auth/sign-out/route");
const { GET: getMe } = await import("@/app/api/events/[event]/me/route");
const { createLoginSession } = await import("@/server/session");
const { createApiToken } = await import("@/server/dal/tokens");

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: fixtureSha } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: fixtureSha, now: NOW });
  setHandleForTests(h);
  jar.cookie = undefined;
  requestHeaders = new Headers();
  cookieDelete.mockClear();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function someUser(): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users ORDER BY id LIMIT 1").get() as { id: string; name: string; email: string };
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles: [], sessionKind: "login" };
}

function loginToken(): string {
  return createLoginSession(h.db, someUser().userId).token;
}

/** A checker session as the seed makes one (kind checker, a label, never expiring). */
function checkerSessionToken(): string {
  const token = "jdga_signouttestcheckertoken0001";
  h.db.insert(sessions).values({ tokenHash: sha256(token), userId: someUser().userId, kind: "checker", label: "judge_a", createdAt: NOW, expiresAt: "9999-12-31T23:59:59.000Z" }).run();
  return token;
}

/** One request: the headers it carries are what next/headers hands the server code. */
async function signOut(headers: Record<string, string> = {}): Promise<{ status: number; body: { signedOut: boolean; reason?: string } }> {
  requestHeaders = new Headers(headers);
  const res = await POST(new Request("http://localhost:8080/api/auth/sign-out", { method: "POST", headers }));
  return { status: res.status, body: await res.json() };
}

async function meStatus(headers: Record<string, string>): Promise<number> {
  requestHeaders = new Headers(headers);
  const res = await getMe(new Request("http://localhost:8080/api/events/evt_01/me", { headers }), { params: Promise.resolve({ event: "evt_01" }) });
  return res.status;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sessionRows = (token: string) => (h.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE token_hash = ?").get(sha256(token)) as { n: number }).n;

describe("POST /api/auth/sign-out with Authorization: Bearer", () => {
  it("ends a Bearer login session: signedOut true, and the same token then gets 401 from /me", async () => {
    const token = loginToken();
    expect(await meStatus(bearer(token))).toBe(200);
    const res = await signOut(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signedOut: true });
    expect(sessionRows(token)).toBe(0);
    expect(await meStatus(bearer(token))).toBe(401);
  });

  it("does not end an API token: signedOut false with the reason, and the token still gets 200 from /me", async () => {
    const { token, id } = createApiToken(someUser(), { name: "ci" });
    expect(await meStatus(bearer(token))).toBe(200);
    const res = await signOut(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.signedOut).toBe(false);
    expect(res.body.reason).toMatch(/API token/);
    expect(res.body.reason).toMatch(/revoke/i);
    expect(await meStatus(bearer(token))).toBe(200);
    const row = h.sqlite.prepare("SELECT revoked_at AS r FROM api_tokens WHERE id = ?").get(id) as { r: string | null };
    expect(row.r).toBeNull();
  });

  it("never ends a checker session sent as a Bearer token: signedOut false, the reason says so, and /me still answers 200", async () => {
    const token = checkerSessionToken();
    const res = await signOut(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.signedOut).toBe(false);
    expect(res.body.reason).toMatch(/checker session/);
    expect(sessionRows(token)).toBe(1);
    expect(await meStatus(bearer(token))).toBe(200);
  });

  it("a token nobody knows is already signed out: signedOut true", async () => {
    expect((await signOut(bearer("not-a-session-token"))).body).toEqual({ signedOut: true });
  });
});

describe("POST /api/auth/sign-out with the session cookie (unchanged)", () => {
  it("ends a cookie login session and clears the cookie", async () => {
    const token = loginToken();
    jar.cookie = token;
    const res = await signOut();
    expect(res.body).toEqual({ signedOut: true });
    expect(cookieDelete).toHaveBeenCalledWith("session");
    expect(sessionRows(token)).toBe(0);
    expect(await meStatus(bearer(token))).toBe(401);
  });

  it("a checker session in the cookie: this browser's cookie is cleared, the session itself stays live, and the answer says so", async () => {
    const token = checkerSessionToken();
    jar.cookie = token;
    const res = await signOut();
    expect(res.body.signedOut).toBe(true);
    expect(res.body.reason).toMatch(/checker session/);
    expect(cookieDelete).toHaveBeenCalledWith("session");
    expect(sessionRows(token)).toBe(1);
    expect(await meStatus(bearer(token))).toBe(200);
  });

  it("a cookie login session and a Bearer API token together: the session ends, the token stays, so not signed out", async () => {
    const session = loginToken();
    const { token } = createApiToken(someUser(), { name: "ci" });
    jar.cookie = session;
    const res = await signOut(bearer(token));
    expect(res.body.signedOut).toBe(false);
    expect(res.body.reason).toMatch(/API token/);
    expect(sessionRows(session)).toBe(0);
    expect(await meStatus(bearer(token))).toBe(200);
  });
});
