import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { actorForToken } from "@/server/session";

// The API twin of the sign-in page's demo buttons (API First): the same identities, the same
// audit row, and a refusal once demo mode is off.
const cookieSet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: cookieSet, get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { POST } = await import("@/app/api/auth/demo-sign-in/route");

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;
let oldSeed: string | undefined;

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/auth/demo-sign-in", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  oldSeed = process.env.SEED_CHECKER_SESSIONS;
  process.env.SEED_CHECKER_SESSIONS = "true";
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  seedCheckerSessions(h.db, "evt_01", NOW);
  setHandleForTests(h);
  cookieSet.mockClear();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  if (oldSeed === undefined) delete process.env.SEED_CHECKER_SESSIONS;
  else process.env.SEED_CHECKER_SESSIONS = oldSeed;
});

describe("POST /api/auth/demo-sign-in", () => {
  it("signs in as a demo identity: 200 with its user id, a session cookie that resolves to it, one audit row", async () => {
    const res = await post({ as: "judge_a" });
    expect(res.status).toBe(200);
    const { userId } = (await res.json()) as { userId: string };
    const judgeA = (h.sqlite.prepare("SELECT user_id AS u FROM sessions WHERE label = 'judge_a'").get() as { u: string }).u;
    expect(userId).toBe(judgeA);
    expect(cookieSet).toHaveBeenCalledTimes(1);
    const token = cookieSet.mock.calls[0]![1] as string;
    expect(actorForToken(h.db, token)?.userId).toBe(judgeA);
    const rows = h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'session.sign_in_demo' AND actor_user_id = ?").get(judgeA) as { n: number };
    expect(rows.n).toBe(1);
  });

  it("known-bad: an unknown label, and any label once demo mode is off, are 403 demo_sign_in_off with no cookie", async () => {
    const unknown = await post({ as: "admin" });
    expect(unknown.status).toBe(403);
    expect(((await unknown.json()) as { error: string }).error).toBe("demo_sign_in_off");

    process.env.SEED_CHECKER_SESSIONS = "false";
    seedCheckerSessions(h.db, "evt_01", NOW);
    const off = await post({ as: "organizer" });
    expect(off.status).toBe(403);
    expect(((await off.json()) as { error: string }).error).toBe("demo_sign_in_off");
    expect(cookieSet).not.toHaveBeenCalled();
  });
});
