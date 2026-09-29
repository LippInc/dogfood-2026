import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import { judgeRows } from "@/server/dal/judges";
import { compareNames, sortByName } from "@/lib/names";

// People's names sort the way a reader expects, not in SQLite's byte order (which puts
// Árpád after Zsolt and every lower-case name after every upper-case one).

describe("compareNames", () => {
  it("puts accented letters with their base letter, ignores case splits, and counts numbers", () => {
    const names = ["Zsolt", "Árpád", "anna", "Bea", "Judge 10", "Judge 9"];
    expect([...names].sort(compareNames)).toEqual(["anna", "Árpád", "Bea", "Judge 9", "Judge 10", "Zsolt"]);
    // the byte order this replaces, for the record
    expect([...names].sort()).toEqual(["Bea", "Judge 10", "Judge 9", "Zsolt", "anna", "Árpád"]);
  });

  it("keeps rows with equal names in the order they came", () => {
    expect(sortByName([{ n: "Ann", i: 1 }, { n: "Ann", i: 2 }, { n: "Aa", i: 3 }], (r) => r.n).map((r) => r.i)).toEqual([3, 1, 2]);
  });
});

describe("the judges of an event", () => {
  const NOW = "2026-09-26T12:00:00.000Z";
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

  it("are listed by name as a reader expects: Árpád among the A's, before Zsolt", () => {
    for (const [id, name] of [
      ["usr_zsolt", "Zsolt Zöld"],
      ["usr_arpad", "Árpád Ács"],
    ]) {
      h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)").run(id, `${id}@example.org`, name, NOW);
      h.sqlite.prepare("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, 'evt_01', 'judge', ?)").run(id, NOW);
    }
    const names = judgeRows(h.db, "evt_01").map((j) => j.name);
    expect(names.indexOf("Árpád Ács")).toBeLessThan(names.indexOf("Zsolt Zöld"));
    expect(names).toEqual([...names].sort(compareNames));
  });
});
