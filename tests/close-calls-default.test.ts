import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import type { Actor } from "@/server/authz";

// With no close-call choice, the sample event publishes exactly what main published before close calls existed: the
// published results, event.json, normalized.csv and the event's fixtures.json, compared with a golden written by the
// same test on main's code (tests/support/close-calls-default.golden.json, WRITE_CLOSE_CALLS_GOLDEN=1). Only what
// changes on every run is masked: generated ids, times, hashes. A search for the new keys covers both spellings, the
// settings' closeCalls and fixtures.json's close_calls.

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }), headers: async () => new Headers() }));

const { acceptUnderReviewed, dismissDuplicate, setJudgeOverride } = await import("@/server/dal/decisions");
const { getPublishedResults, publishResults } = await import("@/server/dal/results");
const { exportFile } = await import("@/server/dal/exports");

const NOW = "2026-09-26T12:00:00.000Z";
const FILES = ["event.json", "normalized.csv", "fixtures.json"] as const;
export const NEW_KEYS = /closeCalls|close_calls|judgesDecisions|decidedIn|"decided"|"decision"/;
let h: Handle;

beforeEach(() => {
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
});

const organizer = (): Actor => ({ userId: "usr_organizer", name: "Organizer", email: "organizer@example.org", isAdmin: false, roles: [{ eventId: "evt_01", role: "organizer" }], sessionKind: "login" });

/** Everything that differs between two runs of the same code: generated ids, the clock, hashes and signatures. */
export function mask(text: string): string {
  return text
    // newId: a short prefix and 12 random lowercase letters or digits (src/server/util.ts)
    .replace(/\b([a-z]{2,5})_[a-z0-9]{12}\b/g, "$1_<id>")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, "<time>")
    .replace(/\b[0-9a-f]{64}\b/g, "<hash>")
    .replace(/"entry":\s*\d+/g, '"entry":<n>');
}

function publishSample() {
  const org = organizer();
  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  dismissDuplicate(org, "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(org, "evt_01");
  return {
    results: mask(JSON.stringify(getPublishedResults("evt_01"), null, 1)),
    ...Object.fromEntries(FILES.map((f) => [f, mask(String(exportFile(org, "evt_01", f).body))])),
  } as Record<string, string>;
}

describe("the sample event with no close-call choice", () => {
  it("publishes byte for byte what main did before close calls: results, event.json, normalized.csv and fixtures.json", () => {
    const now = publishSample();
    const file = path.join(process.cwd(), "tests/support/close-calls-default.golden.json");
    if (process.env.WRITE_CLOSE_CALLS_GOLDEN === "1") fs.writeFileSync(file, `${JSON.stringify(now, null, 1)}\n`);
    const golden = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
    expect(Object.keys(now).sort()).toEqual(Object.keys(golden).sort());
    for (const k of Object.keys(golden)) expect(now[k], k).toBe(golden[k]);
    for (const k of Object.keys(now)) expect(now[k], k).not.toMatch(NEW_KEYS);
  });
});
