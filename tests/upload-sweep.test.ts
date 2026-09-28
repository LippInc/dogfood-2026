import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { sweepOrphanUploads } from "@/server/uploads";

// A picture's file is written before its row commits and deleted after the row that named it changes: a crash in
// between, or a database restored without its pictures, leaves files no project names. The start removes them.

let h: Handle;
let dir: string;
const name = (c: string) => `${c.repeat(22)}.webp`;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
});
afterEach(() => {
  h.sqlite.close();
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
});

function seed() {
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: "2026-09-28T00:00:00.000Z" });
}

describe("the start-up sweep of stored pictures", () => {
  it("known-bad: a file no project names is removed; a named one, and any file that is not an upload, stay", () => {
    seed();
    const projectId = (h.sqlite.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string }).id;
    h.sqlite.prepare("UPDATE projects SET thumbnail_url = ? WHERE id = ?").run(`/uploads/${name("a")}`, projectId);
    for (const n of [name("a"), name("b"), "notes.txt"]) fs.writeFileSync(path.join(dir, n), "x");
    expect(sweepOrphanUploads(h.db, dir)).toEqual({ removed: 1, kept: 1 });
    expect(fs.readdirSync(dir).sort()).toEqual([name("a"), "notes.txt"].sort());
    expect(sweepOrphanUploads(h.db, dir)).toEqual({ removed: 0, kept: 1 }); // the next start finds nothing more
  });

  it("a picture named among a project's links is kept too", () => {
    seed();
    const projectId = (h.sqlite.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string }).id;
    h.sqlite.prepare("UPDATE projects SET gallery_urls = ? WHERE id = ?").run(JSON.stringify([`http://localhost:8080/uploads/${name("c")}`]), projectId);
    fs.writeFileSync(path.join(dir, name("c")), "x");
    expect(sweepOrphanUploads(h.db, dir)).toEqual({ removed: 0, kept: 1 });
  });

  it("a database without a single project empties nothing (a wrong database next to an old pictures folder)", () => {
    fs.writeFileSync(path.join(dir, name("d")), "x");
    const r = sweepOrphanUploads(h.db, dir);
    expect(r.removed).toBe(0);
    expect(r.skipped).toMatch(/no project/);
    expect(fs.existsSync(path.join(dir, name("d")))).toBe(true);
  });

  it("no pictures folder yet is nothing to do", () => {
    expect(sweepOrphanUploads(h.db, path.join(dir, "missing"))).toEqual({ removed: 0, kept: 0 });
  });
});
