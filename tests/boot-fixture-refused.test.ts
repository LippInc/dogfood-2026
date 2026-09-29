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
import { importFixtures } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { sha256 } from "@/server/util";

// A changed fixture file that an event already here refuses (a team past its size, a second project for a team, a
// judge on the team they review, a new criterion after scoring, a rubric past its limits) must not stop the start:
// bootOrExit exits 1 on a throw, and with `restart: unless-stopped` the container loops and the portal stays down.
// The start logs the refusal (which file, which row, which rule) and goes on with the data it has. A file that is
// broken as a file (missing, not JSON, not the fixture format) still stops the start (tests/boot-fixture.test.ts).

const NOW = "2026-09-29T00:00:00.000Z";
let h: Handle;
const saved = process.env.FIXTURES_PATH;
const written: string[] = [];

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
  for (const f of written.splice(0)) fs.rmSync(f, { force: true });
  vi.restoreAllMocks();
});

type Json = Record<string, unknown> & {
  event: { id: string; name: string; submissions_close: string };
  tracks: { id: string; name: string }[];
  judges: { id: string; name: string; email: string; tracks: string[] }[];
  teams: { id: string; name: string; members: string[] }[];
  projects: Record<string, unknown>[];
  scores: { judge: string; project: string; criteria: Record<string, number | null> }[];
  rubric?: { key: string; label: string }[];
};

const fixture = (): Json => JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8")) as Json;

function useFile(content: Json, name: string): string {
  const file = path.join(os.tmpdir(), `ops2-${name}-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(content));
  written.push(file);
  process.env.FIXTURES_PATH = file;
  return file;
}

/** Everything the database holds that an import writes, as one comparable snapshot. */
function snapshot(): string {
  const tables = ["events", "tracks", "users", "user_roles", "judge_tracks", "teams", "team_members", "projects", "rubric_criteria", "assignments", "scores", "score_items", "custom_questions", "fixture_imports", "audit_log"];
  return JSON.stringify(tables.map((t) => (h.sqlite.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n));
}

/** Boots with the changed file: the start goes on, returns the event, imports nothing, and says why in plain words. */
function startsAnyway(file: string, eventId: string, rule: string, row: RegExp) {
  const before = snapshot();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let returned: string | null = null;
  expect(() => {
    returned = bootFixture(h, NOW);
  }).not.toThrow();
  expect(returned).toBe(eventId);
  expect(snapshot()).toBe(before);
  const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
  expect(said).toContain(path.basename(file));
  expect(said).toContain(rule);
  expect(said).toMatch(row);
  expect(said).toContain("nothing from this file was imported; the portal starts with the data it has");
}

describe("a changed fixture file the event here refuses: the portal starts anyway", () => {
  beforeEach(() => {
    expect(bootFixture(h, NOW)).toBe("evt_01"); // a fresh volume imports fixtures.json
  });

  it("a fifth member on tm_05 (team_full)", () => {
    const f = fixture();
    f.teams.find((t) => t.id === "tm_05")!.members.push("fifth@example.org");
    startsAnyway(useFile(f, "team-full"), "evt_01", "team_full", /tm_05/);
  });

  it("a second project for tm_01 (team_has_project)", () => {
    const f = fixture();
    f.projects.push({ id: "prj_99", team: "tm_01", track: "trk_04", title: "A second one", submitted_at: "2026-03-01T12:00:00Z" });
    startsAnyway(useFile(f, "team-project"), "evt_01", "team_has_project", /prj_99/);
  });

  it("a review by a judge who is on the project's team (conflict_of_interest, review side)", () => {
    const f = fixture();
    f.teams.find((t) => t.id === "tm_04")!.members.push("tomas.varga@example.org"); // jdg_01
    f.scores.push({ judge: "jdg_01", project: "prj_04", criteria: { functionality: 3, quality: 3, innovation: 3 } });
    startsAnyway(useFile(f, "coi-review"), "evt_01", "conflict_of_interest", /jdg_01 of prj_04/);
  });

  it("a judge added to the team they review (conflict_of_interest, member side)", () => {
    const f = fixture();
    f.teams.find((t) => t.id === "tm_01")!.members.push("marek.nowak@example.org"); // jdg_08 reviews prj_01
    startsAnyway(useFile(f, "coi-member"), "evt_01", "conflict_of_interest", /tm_01/);
  });

  it("a new criterion after judges scored (rubric_in_use)", () => {
    const f = fixture();
    f.scores[0].criteria.design = 4;
    startsAnyway(useFile(f, "rubric-in-use"), "evt_01", "rubric_in_use", /scored/);
  });

  it("the unchanged fixture at a second start imports nothing and throws nothing (positive control)", () => {
    const before = snapshot();
    expect(bootFixture(h, NOW)).toBe("evt_01");
    expect(snapshot()).toBe(before);
  });

  it("positive control: a changed file the event takes still imports", () => {
    const f = fixture();
    f.teams.find((t) => t.id === "tm_04")!.members.push("second@example.org");
    useFile(f, "takes");
    expect(bootFixture(h, NOW)).toBe("evt_01");
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM team_members WHERE team_id = 'tm_04'").get() as { n: number }).n).toBe(2);
  });
});

describe("a changed rubric the event here refuses before any score: the portal starts anyway", () => {
  const small = (rubric: { key: string; label: string }[]): Json => ({
    event: { id: "evt_small", name: "Small event", submissions_close: "2026-03-01T18:00:00Z" },
    tracks: [{ id: "trk_s", name: "Only track" }],
    rubric,
    judges: [],
    teams: [],
    projects: [],
    scores: [],
  });
  const three = [
    { key: "impact", label: "Impact" },
    { key: "craft", label: "Craft" },
    { key: "clarity", label: "Clarity" },
  ];

  beforeEach(() => {
    useFile(small(three), "small");
    expect(bootFixture(h, NOW)).toBe("evt_small");
  });

  it("a rubric past 16 criteria (ValidationError)", () => {
    const many = [...three, ...Array.from({ length: 14 }, (_, i) => ({ key: `extra_${i}`, label: `Extra ${i}` }))];
    startsAnyway(useFile(small(many), "many"), "evt_small", "at most 16 criteria", /rubric/);
  });

  it("a criterion whose label another one has (ValidationError)", () => {
    startsAnyway(useFile(small([...three, { key: "impact_again", label: "impact" }]), "repeat"), "evt_small", "appears twice", /impact/i);
  });

  it("file ids that two other events hold already", () => {
    // trk_x belongs to evt_a, and trk_x.evt_small (the name the import would give it instead) to evt_b
    const other = (id: string, trackId: string) =>
      importFixtures(
        h.db,
        { event: { id, name: id, submissions_close: "2026-03-01T18:00:00Z", description: "" }, tracks: [{ id: trackId, name: "T" }], questions: [], judges: [], teams: [], projects: [], scores: [] },
        { source: "t", sha256: id, now: NOW },
      );
    other("evt_a", "trk_x");
    other("evt_b", "trk_x.evt_small");
    const f = small(three);
    f.tracks.push({ id: "trk_x", name: "Taken" });
    startsAnyway(useFile(f, "ids"), "evt_small", "id_taken", /trk_x/);
  });
});

describe("a file past the tabs' limits at start", () => {
  const withLongLabel = (): Json => ({
    event: { id: "evt_old", name: "Old event", submissions_close: "2026-03-01T18:00:00Z" },
    tracks: [{ id: "trk_o", name: "Only track" }],
    rubric: [{ key: "impact", label: "I".repeat(70) }],
    judges: [],
    teams: [],
    projects: [],
    scores: [],
  });

  it("a file an older portal imported, past a limit held now, never stops a later start", () => {
    const f = withLongLabel();
    const text = JSON.stringify(f);
    // what an older portal wrote on this volume: the event and the file's import row, sha256 of the file's text
    h.sqlite.prepare("INSERT INTO events (id, slug, name, description, submissions_close_at, created_at) VALUES ('evt_old', 'old-event', 'Old event', '', '2026-03-01T18:00:00Z', ?)").run(NOW);
    h.sqlite.prepare("INSERT INTO fixture_imports (source, sha256, imported_at, counts) VALUES ('old.json', ?, ?, '{}')").run(sha256(text), NOW);
    const file = path.join(os.tmpdir(), `ops2-old-${process.pid}.json`);
    fs.writeFileSync(file, text);
    written.push(file);
    process.env.FIXTURES_PATH = file;
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(bootFixture(h, NOW)).toBe("evt_old");
  });

  it("a changed file past a limit, for an event here: the portal starts anyway", () => {
    const f = withLongLabel();
    f.rubric = [{ key: "impact", label: "Impact" }];
    useFile(f, "old-ok");
    expect(bootFixture(h, NOW)).toBe("evt_old");
    const changed = withLongLabel();
    changed.rubric = [{ key: "impact", label: "Impact" }, { key: "reach", label: "R".repeat(70) }];
    startsAnyway(useFile(changed, "old-long"), "evt_old", "rubric.1.label", /2 to 60 characters/);
  });

  it("known-bad: the same file for an event not here stops the start, naming the row", () => {
    useFile(withLongLabel(), "new-long");
    expect(() => bootFixture(h, NOW)).toThrow(/is not a fixture file: rubric\.0\.label: must be 2 to 60 characters/);
  });
});

describe("a file broken as a file still stops the start (known-bad for the catch above)", () => {
  it("not JSON", () => {
    const file = path.join(os.tmpdir(), `ops2-notjson-${process.pid}.json`);
    fs.writeFileSync(file, "{ nope");
    written.push(file);
    process.env.FIXTURES_PATH = file;
    expect(() => bootFixture(h, NOW)).toThrow(/is not valid JSON/);
  });
});
