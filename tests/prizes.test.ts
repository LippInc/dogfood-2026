import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { createEvent, savePrizes } from "@/server/dal/organize";
import type { Actor } from "@/server/authz";

// The prizes form sends each row back with its id. An id is the row's own, never a new key the
// client picks: one from another event's prize, or the same id twice, would hit the table's primary
// key inside the transaction and answer 500. Both are a 422 on the field, and nothing changes.

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

function actor(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const organizer = () => actor("usr_organizer");

const prizesOf = (eventId: string) =>
  h.sqlite.prepare("SELECT id, name, description FROM prizes WHERE event_id = ? ORDER BY position").all(eventId) as { id: string; name: string; description: string }[];

function expect422(call: () => unknown) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(422);
  expect((caught as HttpError).code).toBe("invalid");
}

describe("savePrizes", () => {
  it("positive control: rows keep their ids through a save, a new row gets a new id, a left-out row goes", () => {
    savePrizes(organizer(), "evt_01", [{ name: "Grand" }, { name: "Runner-up" }]);
    const [grand, runner] = prizesOf("evt_01");
    savePrizes(organizer(), "evt_01", [{ id: runner!.id, name: "Second place" }, { name: "Crowd favourite" }]);
    const after = prizesOf("evt_01");
    expect(after.map((p) => p.name)).toEqual(["Second place", "Crowd favourite"]);
    expect(after[0]!.id).toBe(runner!.id);
    expect(after.some((p) => p.id === grand!.id)).toBe(false);
  });

  it("known-bad: another event's prize id is a 422, and neither event's prizes change", () => {
    const other = createEvent({ ...organizer(), isAdmin: true }, {
      details: { name: "Other Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" },
      tracks: [{ name: "Open" }],
      prizes: [{ name: "Their prize" }],
    });
    savePrizes(organizer(), "evt_01", [{ name: "Ours" }]);
    const theirs = prizesOf(other.id)[0]!;
    expect422(() => savePrizes(organizer(), "evt_01", [{ id: theirs.id, name: "Stolen" }]));
    expect(prizesOf("evt_01").map((p) => p.name)).toEqual(["Ours"]);
    expect(prizesOf(other.id)).toEqual([theirs]);
  });

  it("known-bad: the same id on two rows is a 422, and nothing changes", () => {
    savePrizes(organizer(), "evt_01", [{ name: "Grand" }]);
    const [grand] = prizesOf("evt_01");
    expect422(() => savePrizes(organizer(), "evt_01", [{ id: grand!.id, name: "Grand" }, { id: grand!.id, name: "Grand again" }]));
    expect(prizesOf("evt_01")).toEqual([grand]);
  });

  it("known-bad: an id this event never had is a 422", () => {
    expect422(() => savePrizes(organizer(), "evt_01", [{ id: "prz_made_up", name: "Invented" }]));
  });

  // The refusal names the row by its place alone, as the zod errors of a row do: the rows editor highlights
  // errors["<place>"] and the section lists it as "Prize <place + 1>". "0.id" matched neither.
  function refusal(call: () => unknown): Record<string, string[]> {
    try {
      call();
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      return (err as HttpError).details as Record<string, string[]>;
    }
    throw new Error("expected the call to throw");
  }

  it("known-bad: settings open in two tabs, one removes a prize, the other saves it: the row is named and told to reload", () => {
    savePrizes(organizer(), "evt_01", [{ name: "Grand" }, { name: "Runner-up" }]);
    const [grand, runner] = prizesOf("evt_01");
    // tab A removes Grand and saves
    savePrizes(organizer(), "evt_01", [{ id: runner!.id, name: "Runner-up" }]);
    // tab B still holds Grand as row 1 and edits Runner-up
    const errors = refusal(() => savePrizes(organizer(), "evt_01", [{ id: grand!.id, name: "Grand" }, { id: runner!.id, name: "Second place" }]));
    expect(Object.keys(errors)).toEqual(["0"]);
    expect(errors["0"]!.join(" ")).toMatch(/removed .*since (this|the) page (was )?loaded.*reload the page/i);
    expect(prizesOf("evt_01").map((p) => p.name)).toEqual(["Runner-up"]);
  });

  it("known-bad: a prize on two rows names the second row, by its place", () => {
    savePrizes(organizer(), "evt_01", [{ name: "Grand" }]);
    const [grand] = prizesOf("evt_01");
    const errors = refusal(() => savePrizes(organizer(), "evt_01", [{ name: "New" }, { id: grand!.id, name: "Grand" }, { id: grand!.id, name: "Grand again" }]));
    expect(Object.keys(errors)).toEqual(["2"]);
    expect(errors["2"]!.join(" ")).toMatch(/reload the page/i);
  });
});
