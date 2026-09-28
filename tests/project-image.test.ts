import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { removeProjectImage, setProjectImage } from "@/server/dal/project-image";
import { updateProject } from "@/server/dal/projects";
import { MAX_IMAGE_BYTES, readUpload, sniffImage } from "@/server/uploads";
import type { Actor } from "@/server/authz";

// Every judge's-eye reading marked the portal down for having no uploads: a team could only point at an
// image on its own host. A team member now uploads the project's picture; the portal keeps it in the data
// volume next to the database. Only PNG, JPEG and WebP, told by their first bytes (never by a name or a
// declared type, so no SVG or HTML is ever served back), at most 2 MB, only by the team while submissions
// are open, through the one data access layer with its audit row; a refused upload leaves no file behind.

const NOW = "2026-09-28T02:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x1a, 0, 0, 0]), Buffer.from("WEBPVP8L"), Buffer.alloc(14)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "uploads-test-"));
  process.env.UPLOADS_DIR = dir;
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  // the folder holds only files this test made: remove them one by one, then the empty folder
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
  process.env.UPLOADS_DIR = saved;
});

function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  expect((caught as HttpError).status).toBe(status);
  expect((caught as HttpError).code).toBe(code);
}

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const idByEmail = (email: string) => (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
const member = () => actorById(idByEmail("member1_1@example.org")); // on tm_01, the team behind prj_01
const nonMember = () => actorById(idByEmail("lena2@example.org"));
const openEvent = () => h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
const thumbnailOf = (id: string) => (h.sqlite.prepare("SELECT thumbnail_url AS t FROM projects WHERE id = ?").get(id) as { t: string | null }).t;
const files = () => fs.readdirSync(dir);
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

describe("sniffImage", () => {
  it("tells PNG, JPEG and WebP by their first bytes and nothing else", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPEG)).toBe("jpg");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(HTML)).toBeNull();
    expect(sniffImage(Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe("setProjectImage with the event open", () => {
  beforeEach(openEvent);

  it("stores a team member's PNG in the uploads folder and makes it the project's picture, with its audit row", () => {
    const before = thumbnailOf("prj_01");
    const r = setProjectImage(member(), "prj_01", PNG);
    expect(r.thumbnailUrl).toMatch(/^\/uploads\/[A-Za-z0-9_-]{22}\.png$/);
    expect(thumbnailOf("prj_01")).toBe(r.thumbnailUrl);
    expect(files()).toEqual([r.thumbnailUrl.slice("/uploads/".length)]);
    expect(fs.readFileSync(path.join(dir, files()[0]!)).equals(PNG)).toBe(true);
    const row = auditRows().at(-1)!;
    expect(row.action).toBe("project.image");
    expect(row.targetId).toBe("prj_01");
    expect(row.after).toEqual({ thumbnailUrl: r.thumbnailUrl });
    expect(row.before).toEqual({ thumbnailUrl: before });
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("names the file by what the bytes are: JPEG and WebP too", () => {
    expect(setProjectImage(member(), "prj_01", JPEG).thumbnailUrl).toMatch(/\.jpg$/);
    expect(setProjectImage(member(), "prj_01", WEBP).thumbnailUrl).toMatch(/\.webp$/);
  });

  it("refuses SVG, HTML and anything else with 415, and stores nothing", () => {
    const before = thumbnailOf("prj_01");
    for (const bytes of [SVG, HTML, Buffer.from("hello")]) expectHttpError(() => setProjectImage(member(), "prj_01", bytes), 415, "unsupported_image");
    expect(files()).toEqual([]);
    expect(thumbnailOf("prj_01")).toBe(before);
  });

  it("refuses an image over 2 MB with 413, and stores nothing", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    expectHttpError(() => setProjectImage(member(), "prj_01", big), 413, "image_too_large");
    expect(files()).toEqual([]);
  });

  it("refuses someone not on the team with 403, audits the refusal, and leaves no file behind", () => {
    const before = thumbnailOf("prj_01");
    expectHttpError(() => setProjectImage(nonMember(), "prj_01", PNG), 403, "not_your_project");
    expect(files()).toEqual([]);
    expect(thumbnailOf("prj_01")).toBe(before);
    expect(auditRows().at(-1)!.action).toBe("authz.refused");
  });

  it("refuses no session with 401, no file and no audit row", () => {
    const rows = auditRows().length;
    expectHttpError(() => setProjectImage(null, "prj_01", PNG), 401, "unauthenticated");
    expect(files()).toEqual([]);
    expect(auditRows().length).toBe(rows);
  });

  it("a new picture replaces the old upload's file, and removing the picture deletes it", () => {
    const first = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    const second = setProjectImage(member(), "prj_01", JPEG).thumbnailUrl;
    expect(files()).toEqual([second.slice("/uploads/".length)]);
    expect(first).not.toBe(second);
    const r = removeProjectImage(member(), "prj_01");
    expect(r.thumbnailUrl).toBeNull();
    expect(thumbnailOf("prj_01")).toBeNull();
    expect(files()).toEqual([]);
    expect(auditRows().at(-1)!.action).toBe("project.image");
  });

  it("the project form can send the uploaded picture back unchanged, but no other local path", () => {
    const url = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    const base = { title: "Glass Signal", summary: "s", trackId: "trk_04", repoUrl: "https://example.org/repo/01", status: "submitted" };
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: url });
    expect(thumbnailOf("prj_01")).toBe(url);
    for (const bad of ["/uploads/../portal.db", "/etc/passwd", "/uploads/short.png", "javascript:alert(1)"])
      expectHttpError(() => updateProject(member(), "prj_01", { ...base, thumbnailUrl: bad }), 422, "invalid");
  });
});

describe("setProjectImage while the fixture event is closed", () => {
  it("refuses a team member with 403 submissions_closed, and leaves no file behind", () => {
    expectHttpError(() => setProjectImage(member(), "prj_01", PNG), 403, "submissions_closed");
    expect(files()).toEqual([]);
  });
});

describe("readUpload", () => {
  it("serves only well-formed names from the uploads folder, with the type the name says", () => {
    openEvent();
    const url = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    const got = readUpload(url.slice("/uploads/".length));
    expect(got?.type).toBe("image/png");
    expect(got?.bytes.equals(PNG)).toBe(true);
    for (const bad of ["../portal.db", "..%2Fportal.db", "x.png", `${"a".repeat(22)}.svg`, `${"a".repeat(22)}.png`]) expect(readUpload(bad)).toBeNull();
  });
});
