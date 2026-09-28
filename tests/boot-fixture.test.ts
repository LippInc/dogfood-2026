import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

import { bootFixture } from "@/server/boot";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";

// The fixture file is imported once per database, so what the organizers change or remove stands at every restart.
// Re-importing it at each start (insert-or-ignore) kept their edits but brought deleted rows back: a judge taken off
// a track, a member who left a team (the judge's-eye reading, and README's claim that it never happens). A changed
// file still imports its new rows.

const NOW = "2026-09-28T00:00:00.000Z";
let h: Handle;
const saved = process.env.FIXTURES_PATH;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  delete process.env.FIXTURES_PATH;
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  if (saved === undefined) delete process.env.FIXTURES_PATH;
  else process.env.FIXTURES_PATH = saved;
});

const count = (sql: string, ...args: unknown[]) => (h.sqlite.prepare(sql).get(...args) as { n: number }).n;

describe("the fixture import at start", () => {
  it("imports the file once: a judge taken off a track and a member who left stay removed after a restart", () => {
    expect(bootFixture(h, NOW)).toBe("evt_01");
    const jt = h.sqlite.prepare("SELECT judge_user_id AS j, track_id AS t FROM judge_tracks LIMIT 1").get() as { j: string; t: string };
    const tm = h.sqlite.prepare("SELECT team_id AS team, user_id AS u FROM team_members LIMIT 1").get() as { team: string; u: string };
    h.sqlite.prepare("DELETE FROM judge_tracks WHERE judge_user_id = ? AND track_id = ?").run(jt.j, jt.t);
    h.sqlite.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run(tm.team, tm.u);

    expect(bootFixture(h, NOW)).toBe("evt_01"); // the restart

    expect(count("SELECT count(*) AS n FROM judge_tracks WHERE judge_user_id = ? AND track_id = ?", jt.j, jt.t)).toBe(0);
    expect(count("SELECT count(*) AS n FROM team_members WHERE team_id = ? AND user_id = ?", tm.team, tm.u)).toBe(0);
    expect(count("SELECT count(*) AS n FROM fixture_imports")).toBe(1);
  });

  it("a changed fixture file still imports its new rows (positive control)", () => {
    bootFixture(h, NOW);
    const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8"));
    fixture.tracks.push({ id: "trk_09", name: "A track added later" });
    const changed = path.join(os.tmpdir(), `fixtures-changed-${process.pid}.json`);
    fs.writeFileSync(changed, JSON.stringify(fixture));
    try {
      process.env.FIXTURES_PATH = changed;
      expect(bootFixture(h, NOW)).toBe("evt_01");
      expect(count("SELECT count(*) AS n FROM tracks WHERE name = 'A track added later'")).toBe(1);
      expect(count("SELECT count(*) AS n FROM fixture_imports")).toBe(2);
    } finally {
      fs.unlinkSync(changed);
    }
  });
});
