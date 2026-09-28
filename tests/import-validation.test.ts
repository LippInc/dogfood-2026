import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { FixtureSchema, IMPORT_LIMITS, importFixtures, isIsoDateTime, loadFixtureFile, type Fixture } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");

// An imported file's ids land in addresses, export file names and a Content-Disposition header, and its dates
// drive when submissions close: any string was taken (a quote in an id broke the export's header; "soon" as a
// closing time gave an opaque 500 or a date nobody meant). And no list had a length limit, while every row costs
// queries inside one transaction that holds the database. Each is now a 422 that names the field.

const NOW = "2026-09-28T00:00:00.000Z";
let h: Handle;
let admin: Actor;
const fixtureText = fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8");
const fresh = (): Fixture & Record<string, unknown> => ({ ...JSON.parse(fixtureText), event: { ...JSON.parse(fixtureText).event, id: "evt_new", name: "New Hack" } });

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, "usr_organizer")).all();
  admin = { userId: "usr_organizer", name: "Demo Organizer", email: "organizer@example.org", isAdmin: true, roles, sessionKind: "login" };
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function refusal(body: unknown): { status: number; message: string } {
  try {
    importEventFile(admin, body);
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, message: err.message };
    throw err; // a raw error is exactly what these tests rule out
  }
  return { status: 201, message: "" };
}

describe("the import's ids and dates", () => {
  it("positive control: the organizers' fixture file passes as it is, and a clean new event imports", () => {
    expect(FixtureSchema.safeParse(JSON.parse(fixtureText)).success).toBe(true);
    expect(refusal(fresh()).status).toBe(201);
  });

  it("known-bad: an id with a quote, a slash or a space is refused with 422 naming the field", () => {
    for (const bad of ['evt"x', "../evt", "evt x", ""]) {
      const body = fresh();
      body.event = { ...body.event, id: bad };
      const r = refusal(body);
      expect(r.status, bad).toBe(422);
      expect(r.message).toMatch(/event\.id: must be 1 to 80 letters/);
    }
    const body = fresh();
    body.projects = body.projects.map((p, i) => (i === 3 ? { ...p, team: "team/../x" } : p));
    expect(refusal(body)).toMatchObject({ status: 422, message: expect.stringMatching(/projects\.3\.team/) });
  });

  it("known-bad: a closing time or submission time that is not a real ISO date is refused with 422 naming the field", () => {
    for (const bad of ["soon", "2026-02-30T18:00:00Z", "2026-03-01", "2026-03-01T18:00:00", "01/03/2026 18:00"]) {
      const body = fresh();
      body.event = { ...body.event, submissions_close: bad };
      const r = refusal(body);
      expect(r.status, bad).toBe(422);
      expect(r.message).toMatch(/event\.submissions_close: must be a date and time with its time zone/);
    }
    const body = fresh();
    body.projects = body.projects.map((p, i) => (i === 0 ? { ...p, submitted_at: "yesterday" } : p));
    expect(refusal(body)).toMatchObject({ status: 422, message: expect.stringMatching(/projects\.0\.submitted_at/) });
  });

  it("dates the portal itself writes are taken: seconds, milliseconds, an offset", () => {
    for (const ok of ["2026-03-01T18:00:00Z", "2026-03-01T18:00Z", "2026-09-28T00:00:00.000Z", "2026-03-01T20:00:00+02:00", "2028-02-29T00:00:00Z"]) {
      expect(isIsoDateTime(ok), ok).toBe(true);
    }
  });
});

describe("the import's row limits", () => {
  it("known-bad: a list past its limit is refused with 422 naming it, before any row is written", () => {
    const body = fresh();
    const p = body.projects[0];
    body.projects = Array.from({ length: IMPORT_LIMITS.projects + 1 }, (_, i) => ({ ...p, id: `prj_x${i}` }));
    const r = refusal(body);
    expect(r.status).toBe(422);
    expect(r.message).toMatch(/projects: at most 2,000 projects in one file/);
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM events WHERE id = 'evt_new'").get() as { n: number }).n).toBe(0);
  });

  it("positive control: a list at its limit passes the check", () => {
    const body = fresh();
    const t = body.tracks[0];
    body.tracks = Array.from({ length: IMPORT_LIMITS.tracks }, (_, i) => ({ ...t, id: `trk_x${i}`, name: `Track ${i}` }));
    expect(FixtureSchema.safeParse(body).success).toBe(true);
    body.tracks.push({ ...t, id: "trk_one_more", name: "One more" });
    expect(FixtureSchema.safeParse(body).success).toBe(false);
  });
});
