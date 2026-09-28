import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDemoOrganizer } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { userRoles, users } from "@/server/db/schema";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";
import { saveProjectFields } from "@/server/dal/organize";
import { fieldModes } from "@/server/dal/project-fields";

// The two refusals on saving what teams fill in come from the one permission rule, authorize()'s
// "event.manage" (organizers of this event only), and from nothing else: with that rule taken
// away (authorize answering yes to everything), the participant's 403 turns into a save, and the
// missing session's 401 is gone too (mutate() then stops at having nobody to record). The same
// calls with the rule in place refuse, so the test reads the rule, not an accident of the setup.

const rule = vi.hoisted(() => ({ removed: false }));
vi.mock("@/server/authz", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/authz")>();
  return { ...real, authorize: (...args: Parameters<typeof real.authorize>) => (rule.removed ? { ok: true } : real.authorize(...args)) };
});

const NOW = "2026-09-28T20:00:00.000Z";
let h: Handle;

beforeEach(() => {
  rule.removed = false;
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  rule.removed = false;
  setHandleForTests(null);
  h.sqlite.close();
});

function actor(userId: string): Actor {
  const u = h.db.select().from(users).where(eq(users.id, userId)).get()!;
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, roles, sessionKind: "login" };
}
/** A fixture team member: a participant of the event, not an organizer. */
const participant = () => actor((h.sqlite.prepare("SELECT user_id AS id FROM team_members WHERE team_id = 'tm_01' LIMIT 1").get() as { id: string }).id);

function status(call: () => unknown): number | "no HttpError" | 200 {
  try {
    call();
    return 200;
  } catch (err) {
    return err instanceof HttpError ? err.status : "no HttpError";
  }
}

describe("the refusals come from the event.manage rule", () => {
  it("with the rule: 403 for a participant, 401 without a session, 200 for the organizer", () => {
    expect(status(() => saveProjectFields(participant(), "evt_01", { repoUrl: "required" }))).toBe(403);
    expect(status(() => saveProjectFields(null, "evt_01", { repoUrl: "required" }))).toBe(401);
    expect(fieldModes(h.db, "evt_01").repoUrl).toBe("optional");
    expect(status(() => saveProjectFields(actor("usr_organizer"), "evt_01", { repoUrl: "required" }))).toBe(200);
  });

  it("without it: the participant's save goes through, and the 401 is no longer an answer", () => {
    rule.removed = true;
    expect(status(() => saveProjectFields(participant(), "evt_01", { repoUrl: "required" }))).toBe(200);
    expect(fieldModes(h.db, "evt_01").repoUrl).toBe("required");
    expect(status(() => saveProjectFields(null, "evt_01", { tags: "hidden" }))).toBe("no HttpError");
  });
});
