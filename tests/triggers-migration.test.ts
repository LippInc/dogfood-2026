import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAudit } from "@/server/audit";
import { openDatabase, type Handle } from "@/server/db/client";
import { assertTriggers, TRIGGERS } from "@/server/db/triggers";

// The migrations make every trigger too (drizzle/0012_triggers.sql), so a database built from drizzle/ by any tool,
// without the portal's boot, is guarded. triggers.ts stays the place to change one: a trigger added or changed there
// without a migration would leave the boot to create or restore it, and the second test fails until the migration
// exists.

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  // drizzle's own migrator, as a tool would run it: no boot, so no assertTriggers
  migrate(h.db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
});

afterEach(() => {
  h.sqlite.close();
});

const triggerNames = () =>
  (h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );

describe("the triggers in the migrations", () => {
  it("a database built by the migrations alone has every trigger", () => {
    expect(triggerNames()).toEqual(Object.keys(TRIGGERS).sort());
  });

  it("with the SQL triggers.ts defines: the boot's check then creates nothing and restores nothing", () => {
    expect(assertTriggers(h.sqlite)).toEqual({ created: [], restored: [] });
  });

  it("and they guard that database: the audit log refuses UPDATE and DELETE straight after migrating", () => {
    appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: "test.migrated" }, "2026-09-28T00:00:00.000Z");
    expect(() => h.sqlite.prepare("UPDATE audit_log SET action = 'x'").run()).toThrow(/append-only/);
    expect(() => h.sqlite.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
  });
});
