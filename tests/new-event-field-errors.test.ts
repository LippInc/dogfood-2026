import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { createEvent } from "@/server/dal/organize";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";

// A new event's name and dates travel nested under `details` (the form and POST /api/events alike). A refusal must
// name the field itself (submissionsOpenAt), not the envelope (details): the form marks fields by their own names,
// and an API caller told only "details: expected string, received null" cannot tell which of six fields is wrong.

const NOW = "2026-09-28T00:00:00.000Z";
let h: Handle;
const admin: Actor = { userId: "usr_admin", name: "Admin", email: "admin@example.org", isAdmin: true, roles: [], sessionKind: "login" };

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  h.sqlite.prepare("INSERT INTO users (id, email, name, is_admin, created_at) VALUES (?, ?, ?, 1, ?)").run("usr_admin", "admin@example.org", "Admin", NOW);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

const good = () => ({
  slug: "spring-hack-2027",
  details: { name: "Spring Hack 2027", description: "", submissionsOpenAt: "2027-03-01T09:00", submissionsCloseAt: "2027-03-03T18:00", judgingCloseAt: "", maxTeamSize: "4" },
  tracks: [{ name: "Tools" }],
  prizes: [],
});

function fieldsOf(body: unknown): [number, Record<string, string[]>] {
  try {
    createEvent(admin, body);
  } catch (e) {
    if (e instanceof HttpError) return [e.status, (e.details ?? {}) as Record<string, string[]>];
    throw e;
  }
  return [201, {}];
}

describe("creating an event: a refusal names the field itself", () => {
  it("creates the event when every field is fine (the positive control)", () => {
    expect(fieldsOf(good())).toEqual([201, {}]);
    expect(h.sqlite.prepare("SELECT name FROM events WHERE slug = ?").get("spring-hack-2027")).toEqual({ name: "Spring Hack 2027" });
  });

  it("a date sent as null is refused under its own name, not under details", () => {
    const body = good();
    (body.details as Record<string, unknown>).submissionsOpenAt = null;
    const [status, fields] = fieldsOf(body);
    expect(status).toBe(422);
    expect(Object.keys(fields)).toEqual(["submissionsOpenAt"]);
  });

  it("a short name and a close before the opening are each refused under their own names", () => {
    const body = good();
    body.details.name = "X";
    body.details.submissionsCloseAt = "2027-02-01T18:00";
    const [status, fields] = fieldsOf(body);
    expect(status).toBe(422);
    expect(fields.name?.[0]).toMatch(/at least 3 characters/);
    expect(fields.submissionsCloseAt?.[0]).toMatch(/must be after submissions open/);
    expect(fields.details).toBeUndefined();
  });

  it("fields outside details keep their own keys, and a missing details object is named as such", () => {
    const body = { ...good(), slug: "Not A Slug!", tracks: [] };
    const [, fields] = fieldsOf(body);
    expect(Object.keys(fields).sort()).toEqual(["slug", "tracks"]);
    const [status, missing] = fieldsOf({ slug: "", tracks: [{ name: "Tools" }], prizes: [] });
    expect(status).toBe(422);
    expect(Object.keys(missing)).toEqual(["details"]);
  });
});
