import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";

// The gallery's routes as a browser or a script calls them: the session from the cookie, the file as the body, and
// the answers the API reference promises (201 with the list, 401 with no session, 403 for another team, 413 past
// 8 MB before the body is read, 422 for a body that is no list), and the organizers' take-down route choosing the
// gallery image when the body names one.

const jar = { cookie: undefined as string | undefined };
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: (name: string) => (name === "session" && jar.cookie ? { name, value: jar.cookie } : undefined), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { POST: upload, PUT: setList } = await import("@/app/api/projects/[project]/gallery/route");
const { POST: takeDown } = await import("@/app/api/projects/[project]/take-down-picture/route");
const { createLoginSession } = await import("@/server/session");

const NOW = "2026-09-28T02:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
let h: Handle;
let dir: string;
const saved = process.env.UPLOADS_DIR;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-route-test-"));
  process.env.UPLOADS_DIR = dir;
  jar.cookie = undefined;
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
  process.env.UPLOADS_DIR = saved;
});

const idByEmail = (email: string) => (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
const signIn = (userId: string | null) => {
  jar.cookie = userId ? createLoginSession(h.db, userId).token : undefined;
};
const ctx = (project: string) => ({ params: Promise.resolve({ project }) });
const url = "http://localhost:8080/api/projects/prj_01/gallery";

async function post(body: BodyInit, headers: Record<string, string> = { "content-type": "image/png" }) {
  const res = await upload(new Request(url, { method: "POST", body, headers }), ctx("prj_01"));
  return { status: res.status, body: (await res.json()) as { url?: string; galleryUrls?: string[]; error?: string } };
}
async function put(body: unknown) {
  const res = await setList(new Request(url, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json" } }), ctx("prj_01"));
  return { status: res.status, body: (await res.json()) as { galleryUrls?: string[]; error?: string } };
}

describe("POST and PUT /api/projects/{project}/gallery", () => {
  it("no session is 401; another team is 403; the team's member uploads (201) and reorders (200)", async () => {
    expect((await post(PNG)).status).toBe(401);
    signIn(idByEmail("lena2@example.org"));
    expect(await post(PNG)).toMatchObject({ status: 403, body: { error: "not_your_project" } });
    expect((await put({ galleryUrls: [] })).status).toBe(403);
    signIn(idByEmail("member1_1@example.org"));
    const a = await post(PNG);
    const b = await post(PNG);
    expect(a.status).toBe(201);
    expect(b.body.galleryUrls).toEqual([a.body.url, b.body.url]);
    const r = await put({ galleryUrls: [b.body.url, a.body.url], expected: [a.body.url, b.body.url] });
    expect(r).toEqual({ status: 200, body: { id: "prj_01", galleryUrls: [b.body.url, a.body.url] } });
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it("a declared body past 8 MB is 413 before it is read; a body that is not the list is 422", async () => {
    signIn(idByEmail("member1_1@example.org"));
    expect(await post(PNG, { "content-type": "image/png", "content-length": String(9 * 1024 * 1024) })).toMatchObject({ status: 413, body: { error: "image_too_large" } });
    expect((await post(Buffer.from("<svg/>"))).status).toBe(415);
    expect((await put("not json")).status).toBe(422);
    expect((await put({ galleryUrls: "https://example.org/a.png" })).status).toBe(422);
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("POST /api/projects/{project}/take-down-picture with galleryUrl", () => {
  it("takes the named gallery image down for an organizer, and is 403 for the team", async () => {
    signIn(idByEmail("member1_1@example.org"));
    const a = (await post(PNG)).body.url!;
    const call = async (body: unknown) => {
      const res = await takeDown(new Request("http://localhost:8080/api/projects/prj_01/take-down-picture", { method: "POST", body: JSON.stringify(body) }), ctx("prj_01"));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await call({ reason: "mine", galleryUrl: a })).status).toBe(403);
    signIn("usr_organizer");
    expect(await call({ reason: "Not this project's image", galleryUrl: a })).toEqual({ status: 200, body: { id: "prj_01", galleryUrls: [] } });
    expect(fs.readdirSync(dir)).toEqual([]);
    // without galleryUrl it is still the picture's take-down, as before
    expect(await call({ reason: "Checking the picture" })).toMatchObject({ status: 200, body: { thumbnailUrl: null } });
  });
});
