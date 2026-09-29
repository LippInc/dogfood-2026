import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import type { Actor } from "@/server/authz";

// An API token's "last used" mark is one small write a minute. On a read-only or full volume that write
// fails, and it used to take the whole request down with it (500), so token callers lost even their reads
// while docs/OPERATIONS.md says reads keep working in that state. A missed "last used" minute is fine:
// the request goes on, and the failure is logged once.

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: () => undefined, delete: vi.fn() }),
  headers: async () => requestHeaders,
}));

const { GET: getMe } = await import("@/app/api/events/[event]/me/route");
const { actorForToken } = await import("@/server/session");
const { createApiToken } = await import("@/server/dal/tokens");

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  setHandleForTests(h);
  requestHeaders = new Headers();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  vi.restoreAllMocks();
});

function someUser(): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users ORDER BY id LIMIT 1").get() as { id: string; name: string; email: string };
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles: [], sessionKind: "login" };
}

/** Every write to api_tokens now fails, as it would on a read-only or full volume. */
const breakTokenWrites = () =>
  h.sqlite.exec("CREATE TRIGGER test_api_tokens_readonly BEFORE UPDATE ON api_tokens BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database'); END");

const me = (token: string) => {
  requestHeaders = new Headers({ authorization: `Bearer ${token}` });
  return getMe(new Request("http://localhost:8080/api/events/evt_01/me"), { params: Promise.resolve({ event: "evt_01" }) });
};

describe("an API token on a volume that refuses writes", () => {
  it("still resolves to its person, and a GET with it answers 200; the failure is logged once", async () => {
    const { token, id } = createApiToken(someUser(), { name: "ci" });
    breakTokenWrites();
    // known-bad control: the write the actor lookup makes does fail now
    expect(() => h.sqlite.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(NOW, id)).toThrow(/readonly/);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const actor = actorForToken(h.db, token);
    expect(actor?.userId).toBe(someUser().userId);
    expect(actor?.sessionKind).toBe("api");
    const res = await me(token);
    expect(res.status).toBe(200);
    // the mark is stale, so every request tries again; the log says it once, not once per request
    expect((await me(token)).status).toBe(200);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("last used")).length).toBe(1);
    const row = h.sqlite.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?").get(id) as { last_used_at: string | null };
    expect(row.last_used_at).toBeNull();
  });

  it("positive control: on a working volume the token stamps last used and answers 200; a junk token is 401", async () => {
    const { token, id } = createApiToken(someUser(), { name: "ci" });
    expect((await me(token)).status).toBe(200);
    const row = h.sqlite.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?").get(id) as { last_used_at: string | null };
    expect(row.last_used_at).not.toBeNull();
    expect((await me("dfk_not_a_token")).status).toBe(401);
  });
});
