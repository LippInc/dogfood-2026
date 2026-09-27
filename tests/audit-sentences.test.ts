import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { appendAudit } from "@/server/audit";
import { latestAudit } from "@/server/dal/audit-log";

// Every action the portal writes to the audit log reads as a sentence on the organizer's
// log page, never as its raw name ("System voting.demo_opened"). The actions are read from
// the source: every `action: "x.y"` literal under src/server, minus the permission names
// authorize() takes, which share the same shape. The blind spot: a name that is both a
// permission and an audit action (vote.cast, team.create, ...) is left out here; each of
// those has its sentence already.

const NOW = "2026-09-26T12:00:00.000Z";

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

const text = sources(path.join(process.cwd(), "src/server")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
const authz = fs.readFileSync(path.join(process.cwd(), "src/server/authz.ts"), "utf8");
const union = authz.slice(authz.indexOf("export type Action ="), authz.indexOf(";", authz.indexOf("export type Action =")));
const permissions = new Set([...union.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]!));
const written = [...new Set([...text.matchAll(/action: "([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1]!))].filter((a) => !permissions.has(a)).sort();

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

describe("the audit log speaks in sentences", () => {
  it("finds the actions the portal writes (known-bad guard: an empty or permission-only list would pass anything)", () => {
    expect(permissions.size).toBeGreaterThanOrEqual(15);
    expect(written.length).toBeGreaterThan(40);
    for (const a of ["results.publish", "voter.join_link", "voting.demo_opened", "token.create", "user.claim"]) expect(written).toContain(a);
    expect(written).not.toContain("event.manage");
  });

  it("renders every one of them as words, not as its raw action name", () => {
    for (const action of written) {
      appendAudit(h.db, { actorUserId: null, actorLabel: "system", action, eventId: "evt_01", targetType: "event", targetId: "evt_01", after: {} }, NOW);
    }
    const lines = latestAudit(h.db, "evt_01", 10_000).filter((l) => written.includes(l.action));
    expect(new Set(lines.map((l) => l.action)).size).toBe(written.length);
    const raw = lines.filter((l) => l.parts.map((p) => p.text).join("").includes(l.action)).map((l) => l.action);
    expect(raw).toEqual([]);
  });
});
