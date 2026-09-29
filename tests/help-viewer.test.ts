import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { createEvent } from "@/server/dal/organize";
import { helpViewer } from "@/server/dal/help";
import type { Actor } from "@/server/authz";

// Who asks the Help panel: its ranking and suggestions follow the person's roles (in the event in view, when there
// is one), and its links point at an event that exists. Read on the server through the data access layer.

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

function actor(userId: string, isAdmin = false): Actor {
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId, name: userId, email: `${userId}@example.org`, isAdmin, roles, sessionKind: "login" };
}

const sample = { slug: "sample-hack-2026", name: "Sample Hack 2026" };

describe("the Help panel's reader", () => {
  it("a visitor has no roles, and the links point at the portal's first event", () => {
    expect(helpViewer(null)).toEqual({ signedIn: false, roles: [], event: sample });
    expect(helpViewer(null, sample)).toEqual({ signedIn: false, roles: [], event: sample });
  });

  it("a judge and a team member get their own roles, in the event in view and anywhere", () => {
    const judge = h.db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.role, "judge")).get()!.userId;
    const member = h.db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.role, "participant")).get()!.userId;
    expect(helpViewer(actor(judge), sample).roles).toEqual(["judge"]);
    expect(helpViewer(actor(member)).roles).toEqual(["participant"]);
    expect(helpViewer(actor(member)).signedIn).toBe(true);
  });

  it("on another event's pages only that event's roles count; an administrator counts as its organizer there", () => {
    const organizer = actor("usr_organizer", true);
    const second = createEvent(organizer, {
      details: { name: "Second Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" },
      tracks: [{ name: "Open" }],
      prizes: [],
    });
    const judge = h.db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.role, "judge")).get()!.userId;
    // positive control: in the sample event the judge is a judge
    expect(helpViewer(actor(judge), sample).roles).toEqual(["judge"]);
    // in the second event they hold nothing, so Help does not rank judging first there
    expect(helpViewer(actor(judge), { slug: second.slug, name: "Second Hack" }).roles).toEqual([]);
    // the administrator: organizer and admin in any event in view, admin and their own roles elsewhere
    expect(helpViewer(actor("usr_organizer", true), { slug: second.slug, name: "Second Hack" }).roles).toEqual(["organizer", "admin"]);
    expect(helpViewer({ ...actor("usr_organizer", true), roles: [] }, sample).roles).toEqual(["organizer", "admin"]);
    expect(helpViewer({ ...actor("usr_organizer", true), roles: [] }).roles).toEqual(["admin"]);
  });

  it("with no event in view the links point at the person's own event, organizing first", () => {
    const organizer = actor("usr_organizer", true);
    const second = createEvent(organizer, {
      details: { name: "Second Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" },
      tracks: [{ name: "Open" }],
      prizes: [],
    });
    const onlySecond = { ...actor("usr_organizer", true), roles: [{ eventId: second.id, role: "organizer" as const }] };
    expect(helpViewer(onlySecond).event).toEqual({ slug: second.slug, name: "Second Hack" });
  });
});
