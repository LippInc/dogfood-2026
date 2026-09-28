import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";

// An imported event takes its web address from its name. When another event already had that address, the event
// row was skipped (a bare ON CONFLICT DO NOTHING), the first track then failed its foreign key and the import died
// with a raw SqliteError.

const NOW = "2026-09-28T00:00:00.000Z";
let h: Handle;
beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
});
afterEach(() => h.sqlite.close());

const slugOf = (id: string) => (h.sqlite.prepare("SELECT slug FROM events WHERE id = ?").get(id) as { slug: string } | undefined)?.slug;

describe("an imported event's web address", () => {
  it("known-bad: a second event with the same name imports under the next free address, and the report says so", () => {
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
    const again = { ...fixture, event: { ...fixture.event, id: "evt_02" } };
    const report = importFixtures(h.db, again, { source: "upload", sha256: "other", now: NOW });
    expect(slugOf("evt_02")).toBe("sample-hack-2026-2");
    expect(report.slug).toEqual({ wanted: "sample-hack-2026", used: "sample-hack-2026-2" });
    expect(report.inserted.events).toBe(1);
    expect(report.inserted.tracks).toBe(fixture.tracks.length);
    const third = { ...fixture, event: { ...fixture.event, id: "evt_03" } };
    expect(importFixtures(h.db, third, { source: "upload", sha256: "third", now: NOW }).slug?.used).toBe("sample-hack-2026-3");
  });

  it("positive control: the fixture's own event keeps its address, on a re-import too", () => {
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    expect(importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW }).slug).toBeUndefined();
    expect(slugOf("evt_01")).toBe("sample-hack-2026");
    expect(importFixtures(h.db, fixture, { source: "fixtures.json", sha256: "x", now: NOW }).slug).toBeUndefined();
    expect(slugOf("evt_01")).toBe("sample-hack-2026");
  });
});
