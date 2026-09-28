import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { FixtureSchema, importFixtures } from "@/server/db/import-fixtures";
import { users } from "@/server/db/schema";
import { MAX_GALLERY_IMAGES, MAX_TAG_LENGTH, MAX_TAGS } from "@/server/project-limits";
import type { Actor } from "@/server/authz";

// The event import must take the portal's own fixtures.json export of a big event. This
// measures the exporter's worst case per project and per review (every field at its
// longest) and checks that MAX_EVENT_FILE_BYTES holds 1,000 projects and 8,000 reviews,
// the size the refusal message names; then sends a real file over the old 5 MB cap
// through POST /api/imports.

let bearer: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(bearer ? { authorization: `Bearer ${bearer}` } : {}),
}));

const { exportFile, MAX_EVENT_FILE_BYTES, EVENT_FILE_TOO_LARGE } = await import("@/server/dal");
const { createLoginSession } = await import("@/server/session");
const { POST } = await import("@/app/api/imports/route");

const NOW = "2026-09-28T12:00:00.000Z";
const FEEDBACK_MAX = 4000; // reviews.ts: a review's note
const TITLE_MAX = 120;
const SUMMARY_MAX = 280;
const URL_MAX = 500;
const TEAM_MAX = 20; // organize.ts: most people on one team
const CRITERIA_MAX = 16; // organize.ts: RubricRows
const CRITERION_KEY_MAX = 60;

let h: Handle;
beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  setHandleForTests(h);
  h.db.insert(users).values({ id: "usr_admin", email: "admin@example.org", name: "Admin", isAdmin: true, createdAt: NOW }).run();
});
afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  bearer = null;
});

const url = (n: number, tag: string) => {
  const base = `https://img.example.org/${tag}/${n}/`;
  return base + "a".repeat(URL_MAX - base.length);
};
const email = (n: string) => {
  const tail = `.${n}@example.org`;
  return "m".repeat(254 - tail.length) + tail;
};

/** A fixture with every field at its longest: P projects (each on its own full team), J judges, and every judge reviewing every project when scored. */
function worstFixture(eventId: string, projects: number, judges: number, scored: boolean) {
  const p = Array.from({ length: projects }, (_, i) => i);
  const j = Array.from({ length: judges }, (_, i) => i);
  return {
    event: { id: eventId, name: `Worst case ${eventId}`, submissions_close: "2026-03-01T18:00:00Z" },
    tracks: [{ id: "trk_1", name: "Everything" }],
    judges: j.map((k) => ({ id: `jdg_${k}`, name: `Judge ${k}`, email: email(`${eventId}j${k}`), tracks: ["trk_1"] })),
    teams: p.map((i) => ({ id: `tm_${i}`, name: `T${i}`.padEnd(60, "t"), members: Array.from({ length: TEAM_MAX }, (_, m) => email(`${eventId}t${i}m${m}`)) })),
    projects: p.map((i) => ({
      id: `prj_${i}`,
      team: `tm_${i}`,
      track: "trk_1",
      title: `P${i}`.padEnd(TITLE_MAX, "p"),
      summary: "s".repeat(SUMMARY_MAX),
      repo_url: url(i, "repo"),
      thumbnail_url: url(i, "thumb"),
      gallery_urls: Array.from({ length: MAX_GALLERY_IMAGES }, (_, g) => url(i * 10 + g, "gallery")),
      tags: Array.from({ length: MAX_TAGS }, (_, t) => `${t}`.padEnd(MAX_TAG_LENGTH, "x")),
      submitted_at: "2026-02-27T04:08:00Z",
    })),
    scores: scored
      ? j.flatMap((k) => p.map((i) => ({ judge: `jdg_${k}`, project: `prj_${i}`, criteria: { functionality: 5, quality: 5, innovation: 5 }, comment: "c".repeat(FEEDBACK_MAX) })))
      : [],
  };
}

const admin = (): Actor => ({ userId: "usr_admin", name: "Admin", email: "admin@example.org", isAdmin: true, roles: [], sessionKind: "login" });

function exportedSize(eventId: string, projects: number, judges: number, scored: boolean): { bytes: number; scores: number } {
  const fixture = FixtureSchema.parse(worstFixture(eventId, projects, judges, scored));
  importFixtures(h.db, fixture, { source: "upload", sha256: eventId, now: NOW });
  const body = exportFile(admin(), eventId, "fixtures.json").body;
  return { bytes: Buffer.byteLength(body), scores: JSON.parse(body).scores.length };
}

describe("the event import's size limit", () => {
  it("holds the export of 1,000 projects and 8,000 reviews with every field at its longest", () => {
    const P = 10;
    const J = 10;
    const bare = exportedSize("evt_bare", P, J, false);
    const full = exportedSize("evt_full", P, J, true);
    expect(full.scores).toBe(P * J); // every review made it into the export
    // A review with 16 criteria instead of the fixture's 3: each more one is at most `"<60-char key>": 100,` on its own line.
    const extraCriteria = (CRITERIA_MAX - 3) * (CRITERION_KEY_MAX + 20);
    const perReview = (full.bytes - bare.bytes) / (P * J) + extraCriteria;
    const perProject = bare.bytes / P; // the project, its full team, and a share of the judges and the frame: an upper bound
    const worst = 1000 * perProject + 8000 * perReview;
    expect(perReview).toBeGreaterThan(FEEDBACK_MAX); // the measurement saw the long notes
    expect(worst).toBeLessThanOrEqual(MAX_EVENT_FILE_BYTES);
    // known-bad: the old 5 MB cap could not hold it
    expect(worst).toBeGreaterThan(5_000_000);
  });

  it("POST /api/imports takes a real 6 MB export (over the old 5 MB cap), and refuses a file over the limit with 413 and the plain reason", async () => {
    bearer = createLoginSession(h.db, "usr_admin").token;
    const body = JSON.stringify(worstFixture("evt_big", 30, 50, true));
    expect(Buffer.byteLength(body)).toBeGreaterThan(6_000_000);
    const res = await POST(new Request("http://localhost/api/imports", { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { inserted: { scores: number } }).inserted.scores).toBe(1500);

    const tooBig = await POST(
      new Request("http://localhost/api/imports", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_EVENT_FILE_BYTES + 1) }, body: "{}" }),
    );
    expect(tooBig.status).toBe(413);
    expect(((await tooBig.json()) as { message: string }).message).toBe(EVENT_FILE_TOO_LARGE);
  });

  it("refuses a caller who may not import before reading the body: 401 with no session, whatever the size", async () => {
    const res = await POST(
      new Request("http://localhost/api/imports", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_EVENT_FILE_BYTES + 1) }, body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  it("next.config lets a body of the import's limit through the proxy and the server action", async () => {
    const text = (await import("node:fs")).readFileSync(path.join(process.cwd(), "next.config.ts"), "utf8");
    const mb = (key: string) => Number(new RegExp(`${key}:\\s*"(\\d+)mb"`).exec(text)?.[1] ?? 0) * 1024 * 1024;
    expect(mb("bodySizeLimit")).toBeGreaterThan(MAX_EVENT_FILE_BYTES);
    expect(mb("proxyClientMaxBodySize")).toBeGreaterThan(MAX_EVENT_FILE_BYTES);
  });
});
