import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { appendAudit } from "@/server/audit";
import { ensureDemoOrganizer, DEMO_ORGANIZER } from "@/server/checker";
import { userRoles } from "@/server/db/schema";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import type { Actor } from "@/server/authz";

// The audit log through the API: an event's entries for its organizers, and the portal's own
// entries (the ones no event owns) for administrators, each as the sentence the pages show.
const { getAuditEntries, getPortalEntries } = await import("@/server/dal");

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  resetRateLimits();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function actorOf(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email, is_admin AS a FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string; a: number };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, u.id)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.a === 1, roles, sessionKind: "login" };
}
const judge = () => actorOf(h.db.select({ u: userRoles.userId }).from(userRoles).where(eq(userRoles.role, "judge")).get()!.u);

function statusOf(call: () => unknown): number {
  try {
    call();
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
  return 200;
}

describe("the audit log through the API", () => {
  it("an event's organizer gets its entries newest first, each a sentence with its row and hash, and the chain's state; a judge gets 403, nobody 401", () => {
    const organizer = actorOf(DEMO_ORGANIZER.id);
    const log = getAuditEntries(organizer, "evt_01");
    expect(log.chain.ok).toBe(true);
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.total).toBeGreaterThanOrEqual(log.entries.length);
    const ids = log.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    for (const e of log.entries) {
      expect(typeof e.sentence).toBe("string");
      expect(e.sentence.length).toBeGreaterThan(0);
      expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(getAuditEntries(organizer, "evt_01", { limit: 1 }).entries).toHaveLength(1);
    expect(statusOf(() => getAuditEntries(judge(), "evt_01"))).toBe(403);
    expect(statusOf(() => getAuditEntries(null, "evt_01"))).toBe(401);
  });

  it("the portal's log holds only the entries no event owns, for administrators; an organizer who is not one gets 403", () => {
    h.db.transaction((tx) => {
      appendAudit(tx, { actorUserId: DEMO_ORGANIZER.id, actorLabel: "Demo Organizer", action: "session.sign_in", targetType: "user", targetId: DEMO_ORGANIZER.id }, NOW);
    });
    const admin = actorOf(DEMO_ORGANIZER.id);
    const portal = getPortalEntries(admin);
    expect(portal.entries.some((e) => e.action === "session.sign_in")).toBe(true);
    const eventRows = new Set(
      (h.sqlite.prepare("SELECT id FROM audit_log WHERE event_id IS NOT NULL").all() as { id: number }[]).map((r) => r.id),
    );
    expect(eventRows.size).toBeGreaterThan(0);
    expect(portal.entries.filter((e) => eventRows.has(e.id))).toEqual([]);

    // known-bad: the same person without the administrator flag
    const notAdmin = { ...admin, isAdmin: false };
    expect(statusOf(() => getPortalEntries(notAdmin))).toBe(403);
    expect(statusOf(() => getPortalEntries(judge()))).toBe(403);
    expect(statusOf(() => getPortalEntries(null))).toBe(401);
  });
});
