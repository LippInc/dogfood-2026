import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
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
