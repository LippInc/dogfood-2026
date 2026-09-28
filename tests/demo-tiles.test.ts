import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { demoIdentities } from "@/server/dal/auth";

// The sign-in page's demo tiles are the first screen a hackathon judge meets: each line under a name says who
// that person is in plain words (a judge's tracks), never an internal user id (they read "Judge usr_..." until
// 2026-09-28).
const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;
let oldSeed: string | undefined;

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
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  if (oldSeed === undefined) delete process.env.SEED_CHECKER_SESSIONS;
  else process.env.SEED_CHECKER_SESSIONS = oldSeed;
});

describe("the sign-in page's demo tiles", () => {
  it("name each judge's tracks in plain words, never a raw user id", () => {
    const judges = demoIdentities().filter((d) => d.label === "judge_a" || d.label === "judge_b");
    expect(judges).toHaveLength(2);
    for (const j of judges) {
      expect(j.detail).toMatch(/^Judge for \S/);
      expect(j.detail).not.toContain(j.userId);
      expect(j.detail).not.toMatch(/usr_/);
    }
  });
});
