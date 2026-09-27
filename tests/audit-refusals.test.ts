import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import { userRoles } from "@/server/db/schema";
import { HttpError } from "@/server/errors";
import { LIMITS, resetRateLimits } from "@/server/rate-limit";
import type { Actor } from "@/server/authz";

// One audit row per 403 refusal, and a ceiling per person: past LIMITS.refusal refusals in its
// window the person is answered 429 and nothing is written, so one account cannot fill the log.
const { getAuditLog, setJudgeOverride } = await import("@/server/dal");

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

function actorWith(role: "participant" | "judge"): Actor {
  const row = h.db.select({ u: userRoles.userId }).from(userRoles).where(eq(userRoles.role, role)).get()!;
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(row.u) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, u.id)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

const refusalRows = (userId: string) =>
  (h.sqlite.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'authz.refused' AND actor_user_id = ?").get(userId) as { n: number }).n;

function statusOf(call: () => unknown): number {
  try {
    call();
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
  return 200;
}

describe("refused requests in the audit log", () => {
  it("each 403 writes one row up to the limit; past it the person gets 429 and no row, on reads and writes alike; another person is unaffected", () => {
    const participant = actorWith("participant");
    const judge = actorWith("judge");
    const cap = LIMITS.refusal.capacity;

    for (let i = 0; i < cap; i++) expect(statusOf(() => getAuditLog(participant, "evt_01"))).toBe(403);
    expect(refusalRows(participant.userId)).toBe(cap);

    expect(statusOf(() => getAuditLog(participant, "evt_01"))).toBe(429);
    const override = () => setJudgeOverride(participant, "evt_01", { judgeId: "jdg_07", mode: "exclude", reason: "not mine to decide" });
    expect(statusOf(override)).toBe(429);
    expect(refusalRows(participant.userId)).toBe(cap);

    // positive control: a different person's refusal is still a 403 with its row
    expect(statusOf(() => getAuditLog(judge, "evt_01"))).toBe(403);
    expect(refusalRows(judge.userId)).toBe(1);
  });
});
