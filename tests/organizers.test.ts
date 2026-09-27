import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { createEvent } from "@/server/dal/organize";
import { HttpError } from "@/server/errors";
import { addOrganizer, listOrganizers, removeOrganizer } from "@/server/dal/organizers";
import type { Actor } from "@/server/authz";

// Co-organizers: an organizer adds another account by its email and removes any
// organizer but the last; each change is audited; nobody else can do either.

const NOW = "2026-09-27T00:00:00.000Z";
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
  const u = h.sqlite.prepare("SELECT id, name, email, is_admin AS a FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string; a: number };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: Boolean(u.a), roles, sessionKind: "login" };
}

function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected a refusal");
}

const audits = (action: string) => (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = ?").get(action) as { n: number }).n;
const judge = () => h.sqlite.prepare("SELECT u.id AS id, u.email AS email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = 'judge' LIMIT 1").get() as { id: string; email: string };

describe("co-organizers", () => {
  it("an organizer adds an account by its email; the new organizer can then manage the event; adding twice changes nothing", () => {
    const org = actor("usr_organizer");
    const j = judge();
    expect(addOrganizer(org, "evt_01", { email: j.email.toUpperCase() })).toEqual({ userId: j.id, added: true });
    expect(listOrganizers(org, "evt_01").map((o) => o.userId)).toEqual(expect.arrayContaining(["usr_organizer", j.id]));
    expect(audits("event.organizer_added")).toBe(1);
    expect(listOrganizers(actor(j.id), "evt_01")).toHaveLength(2); // the new organizer passes the same check
    expect(addOrganizer(org, "evt_01", { email: j.email })).toEqual({ userId: j.id, added: false });
    expect(audits("event.organizer_added")).toBe(1);
  });

  it("removes an organizer but never the last one", () => {
    const org = actor("usr_organizer");
    const j = judge();
    addOrganizer(org, "evt_01", { email: j.email });
    expect(removeOrganizer(org, "evt_01", j.id)).toEqual({ removed: true });
    expect(audits("event.organizer_removed")).toBe(1);
    const last = refusal(() => removeOrganizer(org, "evt_01", "usr_organizer"));
    expect([last.status, last.code]).toEqual([409, "last_organizer"]);
    expect(listOrganizers(org, "evt_01").map((o) => o.userId)).toEqual(["usr_organizer"]);
  });

  it("known-bad: a judge or participant cannot add or remove organizers (403, audited), and an unknown address is 404", () => {
    const j = judge();
    const before = audits("authz.refused");
    const added = refusal(() => addOrganizer(actor(j.id), "evt_01", { email: j.email }));
    expect(added.status).toBe(403);
    const removed = refusal(() => removeOrganizer(actor(j.id), "evt_01", "usr_organizer"));
    expect(removed.status).toBe(403);
    expect(audits("authz.refused")).toBe(before + 2);
    const unknown = refusal(() => addOrganizer(actor("usr_organizer"), "evt_01", { email: "nobody@example.org" }));
    expect([unknown.status, unknown.code]).toEqual([404, "no_account"]);
    expect(audits("event.organizer_added")).toBe(0);
  });

  it("known-bad: no session is 401", () => {
    expect(refusal(() => addOrganizer(null, "evt_01", { email: "x@example.org" })).status).toBe(401);
    expect(refusal(() => listOrganizers(null, "evt_01")).status).toBe(401);
  });
});

describe("an organizer reaches only accounts with no place in an event they do not run", () => {
  /** A second event, run by an administrator and by X, an organizer who is not one. */
  function secondEventWithX(): { id: string; x: Actor } {
    const second = createEvent(actor("usr_organizer"), {
      details: { name: "Second Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" },
      tracks: [{ name: "Open" }],
      prizes: [],
    });
    const add = h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)");
    add.run("usr_x", "x@example.org", "Organizer X", NOW);
    add.run("usr_fresh", "fresh@example.org", "Fresh Account", NOW);
    addOrganizer(actor("usr_organizer"), second.id, { email: "x@example.org" });
    return { id: second.id, x: actor("usr_x") };
  }

  it("known-bad: X cannot make a judge of the fixture event an organizer of X's event (403, audited, no role)", () => {
    const { id, x } = secondEventWithX();
    const j = judge();
    const before = audits("authz.refused");
    const err = refusal(() => addOrganizer(x, id, { email: j.email }));
    expect([err.status, err.code]).toEqual([403, "account_in_other_event"]);
    expect(audits("authz.refused")).toBe(before + 1);
    const row = h.sqlite.prepare("SELECT after FROM audit_log WHERE action = 'authz.refused' ORDER BY id DESC LIMIT 1").get() as { after: string };
    expect(JSON.parse(row.after)).toMatchObject({ attempted: "organizer.add", code: "account_in_other_event" });
    expect(h.sqlite.prepare("SELECT count(*) AS n FROM user_roles WHERE user_id = ? AND event_id = ?").get(j.id, id)).toEqual({ n: 0 });
  });

  it("positive controls: X adds an account with no other place; an organizer of both events, and the administrator, reach the fixture's judges", () => {
    const { id, x } = secondEventWithX();
    expect(addOrganizer(x, id, { email: "fresh@example.org" })).toEqual({ userId: "usr_fresh", added: true });
    const [j1, j2] = h.sqlite
      .prepare("SELECT DISTINCT u.id AS id, u.email AS email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.event_id = 'evt_01' AND r.role = 'judge' ORDER BY u.email LIMIT 2")
      .all() as { id: string; email: string }[];
    // X, once also an organizer of the fixture event, reaches its judges
    addOrganizer(actor("usr_organizer"), "evt_01", { email: "x@example.org" });
    expect(addOrganizer(actor("usr_x"), id, { email: j1!.email })).toEqual({ userId: j1!.id, added: true });
    // the administrator reaches everyone, even a judge of an event they do not run
    h.sqlite.prepare("DELETE FROM user_roles WHERE user_id = 'usr_organizer' AND event_id = 'evt_01'").run();
    expect(addOrganizer(actor("usr_organizer"), id, { email: j2!.email })).toEqual({ userId: j2!.id, added: true });
  });
});
