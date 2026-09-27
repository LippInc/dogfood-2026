import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { getOverview } from "@/server/dal/overview";
import { exportFile } from "@/server/dal/exports";
import { createEvent, organizedEvents, updateEventDetails } from "@/server/dal/organize";
import { actorNav } from "@/server/dal/nav";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";

// The organizers' published role matrix gives ADMIN every column ORGANIZER has (own scores, peer scores, other
// track, aggregate, audit log), and every column there is a right to read. So a portal administrator sees every
// event as its organizers do; changing an event stays with its organizers (an import onto someone else's event is
// refused, tests/import-claims.test.ts). Someone who is neither stays refused.

const NOW = "2026-09-27T00:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  const add = h.sqlite.prepare("INSERT INTO users (id, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)");
  add.run("usr_admin2", "chair@example.org", "Second Administrator", 1, NOW); // an administrator with no role anywhere
  add.run("usr_plain", "plain@example.org", "Plain Person", 0, NOW); // no role, not an administrator
  add.run("usr_org2", "org2@example.org", "Other Organizer", 0, NOW); // organizer of evt_01 only, not an administrator
  h.sqlite.prepare("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, ?, ?, ?)").run("usr_org2", "evt_01", "organizer", NOW);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function actor(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email, is_admin AS a FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string; a: number };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: Boolean(u.a), roles, sessionKind: "login" };
}

function refusal(fn: () => unknown): [number, string] {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return [e.status, e.code];
    throw e;
  }
  return [200, "ok"];
}

describe("a portal administrator sees every event", () => {
  it("opens an event's organizer overview and export without any role in it", () => {
    const admin = actor("usr_admin2");
    expect(admin.roles).toEqual([]);
    expect(getOverview(admin, "evt_01").event.id).toBe("evt_01");
    expect(exportFile(admin, "evt_01", "event.json").body.length).toBeGreaterThan(100);
  });

  it("but does not change an event they do not organize", () => {
    const admin = actor("usr_admin2");
    expect(refusal(() => updateEventDetails(admin, "evt_01", { name: "Renamed" }))).toEqual([403, "not_an_organizer"]);
  });

  it("while someone with no role who is not an administrator is refused both (positive control)", () => {
    const plain = actor("usr_plain");
    expect(refusal(() => getOverview(plain, "evt_01"))).toEqual([403, "not_an_organizer"]);
    expect(refusal(() => exportFile(plain, "evt_01", "event.json"))).toEqual([403, "not_an_organizer"]);
  });

  it("lists every event on Your events; an organizer who is not an administrator sees only their own", () => {
    const second = createEvent(actor("usr_organizer"), {
      details: { name: "Second Event", submissionsCloseAt: "2026-12-01T18:00:00Z" },
      tracks: [{ name: "Open" }],
      prizes: [],
    }) as { id: string };
    const adminIds = organizedEvents(actor("usr_admin2")).events.map((e) => e.id);
    expect(adminIds).toEqual(expect.arrayContaining(["evt_01", second.id]));
    expect(organizedEvents(actor("usr_org2")).events.map((e) => e.id)).toEqual(["evt_01"]);
  });

  it("shows the organizer link on any event's own pages", () => {
    const links = actorNav(actor("usr_admin2"), "evt_01").map((l) => l.href);
    expect(links).toContain("/organize/sample-hack-2026");
    expect(actorNav(actor("usr_plain"), "evt_01")).toEqual([]);
  });
});
