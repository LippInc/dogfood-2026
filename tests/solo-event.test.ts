import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { teams, userRoles, users } from "@/server/db/schema";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";
import { createEvent, updateEventDetails } from "@/server/dal/organize";
import { getMyWork } from "@/server/dal/projects";
import { createTeam, joinTeam } from "@/server/dal/teams";

// An event of one person per team (most people on one team: 1) has no team to form: taking part
// needs no team name, the entry goes by the person's own name unless they give another, and
// nobody can join it. Every other event still asks for a team name.

const NOW = "2026-09-28T20:00:00.000Z";
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

function actor(userId: string): Actor {
  const u = h.db.select().from(users).where(eq(users.id, userId)).get()!;
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, roles, sessionKind: "login" };
}

let n = 0;
function person(name: string): Actor {
  const id = `usr_solo${++n}`;
  h.db.insert(users).values({ id, email: `${id}@example.org`, name, passwordHash: null, isAdmin: false, createdAt: NOW }).run();
  return actor(id);
}

function event(maxTeamSize: number): string {
  return createEvent(actor("usr_organizer"), {
    details: { name: `Jam for ${maxTeamSize} ${++n}`, submissionsCloseAt: "2099-01-01T00:00", maxTeamSize },
    tracks: [{ name: "The brief" }],
  }).slug;
}

const status = (call: () => unknown) => {
  try {
    call();
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
};

describe("one person per team", () => {
  it("takes part without a team name: the entry goes by the person's name, or the name they give", () => {
    const slug = event(1);
    const ada = person("Ada Lovelace");
    expect(createTeam(ada, slug, {}).name).toBe("Ada Lovelace");
    const grace = person("Grace Hopper");
    expect(createTeam(grace, slug, { name: "   " }).name).toBe("Grace Hopper");
    const alan = person("Alan Turing");
    expect(createTeam(alan, slug, { name: "Bombe" }).name).toBe("Bombe");
  });

  it("nobody joins an entry of one (409 team_full)", () => {
    const slug = event(1);
    const team = createTeam(person("Solo"), slug, {});
    const code = h.db.select({ c: teams.inviteCode }).from(teams).where(eq(teams.id, team.id)).get()!.c;
    expect(status(() => joinTeam(person("Visitor"), code))).toBe(409);
  });

  it("control: an event of teams still refuses a team without a name (422)", () => {
    const slug = event(4);
    expect(status(() => createTeam(person("Linus"), slug, {}))).toBe(422);
    expect(status(() => createTeam(person("Linus 2"), slug, { name: "" }))).toBe(422);
  });

  it("the one-person view is for an entry of one: a team formed before the size was lowered to 1 keeps the team view", () => {
    const slug = event(4);
    const captain = person("Captain");
    const team = createTeam(captain, slug, { name: "Three of us" });
    const code = h.db.select({ c: teams.inviteCode }).from(teams).where(eq(teams.id, team.id)).get()!.c;
    joinTeam(person("Second"), code);
    joinTeam(person("Third"), code);
    const newcomer = person("Newcomer");
    // the control: in an event of teams, nobody gets the one-person view
    expect(getMyWork(captain, slug).solo).toBe(false);
    expect(getMyWork(newcomer, slug).solo).toBe(false);

    updateEventDetails(actor("usr_organizer"), slug, { name: "Jam lowered to one", submissionsCloseAt: "2099-01-01T00:00", maxTeamSize: 1 });
    expect(getMyWork(captain, slug).solo).toBe(false);
    // someone taking part from now on is one person: the one-person view, and their entry is theirs alone
    expect(getMyWork(newcomer, slug).solo).toBe(true);
    createTeam(newcomer, slug, {});
    expect(getMyWork(newcomer, slug).solo).toBe(true);
  });
});
