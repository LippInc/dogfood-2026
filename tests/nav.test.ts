import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { createEvent } from "@/server/dal/organize";
import { actorNav } from "@/server/dal/nav";
import type { Actor } from "@/server/authz";

// The top bar on an event's pages lists the visitor's roles in that event only;
// someone with roles in two events once saw "Organizer" (or "My project") twice.

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

function organizer(): Actor {
  const roles = h.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, "usr_organizer"))
    .all();
  return { userId: "usr_organizer", name: "Demo Organizer", email: "organizer@example.org", isAdmin: true, roles, sessionKind: "login" };
}

describe("the top bar's role links", () => {
  it("on an event's own pages lists only that event's roles", () => {
    const second = createEvent(organizer(), {
      details: { name: "Second Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" },
      tracks: [{ name: "Open" }],
      prizes: [],
    });
    const both = organizer();

    // positive control: unscoped, an organizer of two events gets two "Organizer" links
    expect(actorNav(both).filter((l) => l.label === "Organizer")).toHaveLength(2);

    expect(actorNav(both, "evt_01")).toEqual([{ href: "/organize/sample-hack-2026", label: "Organizer" }]);
    expect(actorNav(both, second.id)).toEqual([{ href: `/organize/${second.slug}`, label: "Organizer" }]);
    expect(actorNav(both, "evt_elsewhere")).toEqual([]);
    expect(actorNav(null, "evt_01")).toEqual([]);
  });
});
