import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { events } from "@/server/db/schema";
import { getMyWork } from "@/server/dal/projects";
import { actorForToken } from "@/server/session";

// A hole a judge's-eye review found (2026-09-27): a participant's own view carried
// the event's organizer settings.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function checker(label: "organizer" | "participant") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
}

function outcome(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
    return { status: 200 };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status ?? 500, code: e.code };
  }
}

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

describe("a participant's own view carries no organizer settings", () => {
  it("leaves out the under-reviewed list, the vote link's hash and the published run, which the stored row has", () => {
    const row = h.db.select().from(events).where(eq(events.id, "evt_01")).get()!;
    const planted = {
      ...row.settings,
      acceptedUnderReviewed: ["prj_19"],
      publishedRunId: "run_secret",
      voting: { modes: ["link" as const], votesPerVoter: 3, linkHash: "hash-of-the-open-link" },
    };
    h.db.update(events).set({ settings: planted }).where(eq(events.id, "evt_01")).run();
    // Known-bad control: the stored row really holds them.
    const stored = JSON.stringify(h.db.select().from(events).where(eq(events.id, "evt_01")).get()!.settings);
    expect(stored).toContain("hash-of-the-open-link");

    const mine = JSON.stringify(getMyWork(checker("participant"), "evt_01"));
    for (const secret of ["acceptedUnderReviewed", "hash-of-the-open-link", "run_secret", "linkHash"]) {
      expect(mine).not.toContain(secret);
    }
    expect(mine).toContain(row.submissionsCloseAt);
  });
});
