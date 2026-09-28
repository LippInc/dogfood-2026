import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";

// The fixture event in an in-memory database, fresh for every test, with the demo organizer
// (usr_organizer) added: the set-up most DAL tests share. Call withFixtureEvent() once at the
// top of a test file; the helpers read the current handle.

export const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

export function withFixtureEvent() {
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
  return () => h;
}

export function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect({ status: error.status, code: error.code, message: error.message }).toMatchObject({ status, code });
  return error;
}

export const sqlGet = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).get(...args) as T | undefined;
export const sqlAll = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).all(...args) as T[];
export const sqlRun = (sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).run(...args);
export const count = (sql: string, ...args: unknown[]) => (h.sqlite.prepare(sql).get(...args) as { n: number }).n;
export const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

export function actorById(userId: string): Actor {
  const u = sqlGet<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE id = ?", userId);
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

export function addUser(id: string, email: string, name: string): Actor {
  sqlRun("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)", id, email, name, NOW);
  return actorById(id);
}

export const organizer = () => actorById("usr_organizer");
