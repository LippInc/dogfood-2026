import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { events } from "@/server/db/schema";
import { updateEventDetails } from "@/server/dal/organize";
import { getMyWork } from "@/server/dal/projects";
import { actorForToken } from "@/server/session";

// Two holes a judge's-eye review found (2026-09-27): a participant's own view carried
// the event's organizer settings, and an organizer could reopen submissions after
// judges had scored. Each refusal has its positive control.

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

describe("the submission deadline holds once judges have scored", () => {
  const body = (close: string) => ({ name: "Sample Hack 2026", description: "", submissionsCloseAt: close, maxTeamSize: 4 });

  it("refuses moving it later (reopening submissions) with 409 judging_started, and allows moving it earlier", () => {
    const org = checker("organizer");
    const close = h.db.select().from(events).where(eq(events.id, "evt_01")).get()!.submissionsCloseAt;
    expect(outcome(() => updateEventDetails(org, "evt_01", body("2099-01-01T18:00:00Z")))).toEqual({ status: 409, code: "judging_started" });
    expect(h.db.select().from(events).where(eq(events.id, "evt_01")).get()!.submissionsCloseAt).toBe(close);
    const earlier = new Date(Date.parse(close) - 3_600_000).toISOString();
    expect(outcome(() => updateEventDetails(org, "evt_01", body(earlier))).status).toBe(200);
  });

  it("positive control: with no review saved yet, the organizer can still move it later", () => {
    const org = checker("organizer");
    h.sqlite.exec("DELETE FROM score_items; DELETE FROM score_comments; DELETE FROM scores;");
    expect(outcome(() => updateEventDetails(org, "evt_01", body("2099-01-01T18:00:00Z"))).status).toBe(200);
  });
});
