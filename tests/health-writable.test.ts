import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

import { bootFixture } from "@/server/boot";
import { healthCheck } from "@/server/dal/auth";
import { dataFolderProblem, openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";

// A full or read-only /data volume keeps every read working while every write fails; the health check used to
// answer 200 all the same. It now writes a small file next to the database (cached) and answers 503 when it cannot.

let h: Handle;
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-"));
  h = openDatabase(path.join(dir, "portal.db"));
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  delete process.env.FIXTURES_PATH;
  bootFixture(h, "2026-09-28T00:00:00.000Z");
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
});

describe("the health check notices a data folder that takes no writes", () => {
  it("positive control: a writable folder is healthy, and the probe file is gone afterwards", () => {
    expect(healthCheck()).toEqual({ ok: true, events: 1 });
    expect(fs.existsSync(path.join(dir, ".health-probe"))).toBe(false);
  });

  it("known-bad: a folder the portal cannot write to answers not ok, with the reason", () => {
    // A path whose folder is a file: every write there fails, as on a read-only volume.
    const blocker = path.join(dir, "not-a-folder");
    fs.writeFileSync(blocker, "x");
    setHandleForTests({ ...h, file: path.join(blocker, "portal.db") });
    const health = healthCheck();
    expect(health.ok).toBe(false);
    expect(health.problem).toMatch(/cannot be written/);
    setHandleForTests(h);
  });

  it("keeps the answer for a while, so polling costs at most one write per half minute", () => {
    const t = 1_000_000;
    expect(dataFolderProblem(h, t)).toBeNull();
    // each folder is probed on its own, and an answer is reused for a while
    const blocker = path.join(dir, "file-as-folder");
    fs.writeFileSync(blocker, "x");
    const other = { ...h, file: path.join(blocker, "portal.db") };
    expect(dataFolderProblem(other, t)).toMatch(/cannot be written/); // another folder is probed on its own
    expect(dataFolderProblem(other, t + 4_000)).toMatch(/cannot be written/);
    fs.unlinkSync(blocker);
    fs.mkdirSync(blocker);
    expect(dataFolderProblem(other, t + 4_000)).toMatch(/cannot be written/); // still cached
    expect(dataFolderProblem(other, t + 6_000)).toBeNull(); // a failure is kept for 5 s only
    fs.rmdirSync(blocker);
  });
});
