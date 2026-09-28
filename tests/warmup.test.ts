import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

import { bootFixture } from "@/server/boot";
import { healthCheck } from "@/server/dal/auth";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { selfBase, warmingUp, warmUp, warmUpSteps, type WarmResult } from "@/server/warmup";

// "portal ready" and a 200 from /api/health mean the portal has already answered the gallery and the routes the
// acceptance checker asks first: the checker makes one request per check with a 10 s timeout, and a cold first
// gallery render once took longer than that on a busy laptop.

let h: Handle;
beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  delete process.env.FIXTURES_PATH;
  bootFixture(h, "2026-09-28T00:00:00.000Z");
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

describe("the start-up warm-up", () => {
  it("asks for the gallery first, then the routes run.py hits, all anonymously", () => {
    const steps = warmUpSteps({ id: "evt_01", slug: "sample-hack-2026" });
    expect(steps[0]).toEqual({ method: "GET", path: "/events/sample-hack-2026" });
    expect(steps.map((s) => s.path)).toEqual(
      expect.arrayContaining(["/api/events/evt_01/projects", "/api/judge/scores", "/api/events/evt_01/export/scores.csv"]),
    );
  });

  it("the health check answers not ready while it runs and ready once it is done", async () => {
    expect(healthCheck().ok).toBe(true); // positive control: a seeded portal with no warm-up running
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      await gate;
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    let results: WarmResult[] | null = null;
    const running = warmUp("http://127.0.0.1:1", [{ method: "GET", path: "/events/x" }], (r) => (results = r), fakeFetch);
    expect(warmingUp()).toBe(true);
    expect(healthCheck()).toMatchObject({ ok: false, problem: "warming up" });
    release();
    await running;
    expect(warmingUp()).toBe(false);
    expect(healthCheck().ok).toBe(true);
    expect(seen).toEqual(["http://127.0.0.1:1/events/x"]);
    expect(results![0]).toMatchObject({ path: "/events/x", status: 200 });
  });

  it("keeps trying while the server is not listening yet, then goes on", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed: ECONNREFUSED");
      return new Response("", { status: 401 });
    }) as typeof fetch;
    let results: WarmResult[] = [];
    await warmUp("http://127.0.0.1:1", [{ method: "GET", path: "/api/judge/scores" }], (r) => (results = r), fakeFetch);
    expect(calls).toBe(3);
    expect(results[0].status).toBe(401);
    expect(warmingUp()).toBe(false);
  });

  it("reads the port the server listens on", () => {
    expect(selfBase("8080")).toBe("http://127.0.0.1:8080");
    expect(selfBase(undefined)).toBe("http://127.0.0.1:3000");
  });
});
