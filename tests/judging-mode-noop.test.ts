import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { setJudgingMode } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";

// Saving "How judges judge" without changing it said "Pairwise from now on" and logged nothing, so an
// organizer could not tell a switch from a no-op. setJudgingMode says whether the mode changed; only
// a change writes its audit row.

const NOW = "2026-09-28T01:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function organizer() {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === "organizer")!.token)!;
}

const modeRows = () => (h.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'event.judging_mode'").get() as { n: number }).n;

beforeEach(() => {
  process.env.SEED_CHECKER_SESSIONS = "true";
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  process.env.SEED_CHECKER_SESSIONS = saved.flag;
});

describe("saving the judging mode says whether it changed", () => {
  it("a switch reports changed and writes one audit row (the positive control)", () => {
    expect(setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" })).toEqual({ mode: "pairwise", changed: true });
    expect(modeRows()).toBe(1);
  });

  it("saving the mode the event already has reports unchanged and writes nothing", () => {
    expect(setJudgingMode(organizer(), "evt_01", { mode: "scores", reason: "keep it" })).toEqual({ mode: "scores", changed: false });
    expect(modeRows()).toBe(0);
  });
});
