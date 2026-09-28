import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { exportFile } from "@/server/dal/exports";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { removeProjectImage, setProjectImage, takeDownProjectImage } from "@/server/dal/project-image";
import { createProject, updateProject } from "@/server/dal/projects";
import { createTeam } from "@/server/dal/teams";
import { MAX_IMAGE_BYTES, readUpload, sniffImage, stripMetadata } from "@/server/uploads";
import type { Actor } from "@/server/authz";

// Every judge's-eye reading marked the portal down for having no uploads: a team could only point at an
// image on its own host. A team member now uploads the project's picture; the portal keeps it in the data
// volume next to the database. Only PNG, JPEG and WebP, told by their first bytes (never by a name or a
// declared type, so no SVG or HTML is ever served back), at most 2 MB, only by the team while submissions
// are open, through the one data access layer with its audit row; a refused upload leaves no file behind.

const NOW = "2026-09-28T02:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
// the smallest well-formed JPEG stream: start, a JFIF header with its right length, end
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
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

// Phone photos carry where they were taken; a picture here is public, so what is not the picture goes.
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const JPEG_WITH_GPS = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  seg(0xe1, Buffer.from("Exif\0\0GPSLatitude 59.43N GPSLongitude 24.75E", "latin1")),
  seg(0xfe, Buffer.from("shot at home", "latin1")),
  seg(0xdb, Buffer.alloc(65, 1)),
  seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]),
]);
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
};
const PNG_WITH_TEXT = Buffer.concat([PNG.subarray(0, 33), chunk("tEXt", Buffer.from("Comment\0GPS 59.43N 24.75E", "latin1")), chunk("eXIf", Buffer.from("MM\0*GPS", "latin1")), PNG.subarray(33)]);
const riffChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, "latin1"), len, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const webp = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from("RIFF"), size, body]);
};
// a well-formed WebP: RIFF, its size, WEBP, one image chunk
const WEBP = webp(riffChunk("VP8L", Buffer.alloc(14, 7)));
const WEBP_WITH_EXIF = webp(riffChunk("VP8X", Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), riffChunk("VP8L", Buffer.alloc(9, 7)), riffChunk("EXIF", Buffer.from("GPS 59.43N 24.75E")), riffChunk("XMP ", Buffer.from("<x>GPS</x>")));
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));

describe("stripMetadata", () => {
  it("takes EXIF, XMP, IPTC and comments out of a JPEG and keeps the image data", () => {
    const out = stripMetadata(JPEG_WITH_GPS, "jpg")!;
    expect(has(out, "GPS")).toBe(false);
    expect(has(out, "shot at home")).toBe(false);
    expect(has(out, "JFIF")).toBe(true);
    expect(Buffer.from(out).subarray(-7).equals(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd9]))).toBe(true);
    expect(sniffImage(out)).toBe("jpg");
  });

  it("takes text and EXIF chunks out of a PNG, and leaves a PNG without them byte for byte", () => {
    const out = stripMetadata(PNG_WITH_TEXT, "png")!;
    expect(has(out, "GPS")).toBe(false);
    expect(Buffer.from(out).equals(PNG)).toBe(true);
    expect(Buffer.from(stripMetadata(PNG, "png")!).equals(PNG)).toBe(true);
  });

  it("takes EXIF and XMP chunks out of a WebP, fixing its size and its flags", () => {
    const out = Buffer.from(stripMetadata(WEBP_WITH_EXIF, "webp")!);
    expect(has(out, "GPS")).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0);
    expect(has(out, "VP8L")).toBe(true);
  });

  it("refuses a file whose structure does not hold (null), rather than store it with what it hides", () => {
    expect(stripMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x45, 0x78]), "jpg")).toBeNull();
    expect(stripMetadata(Buffer.concat([PNG.subarray(0, 8), Buffer.from([0, 0, 0x7f, 0xff]), Buffer.from("tEXt")]), "png")).toBeNull();
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

  it("stores a phone photo without where it was taken", () => {
    const url = setProjectImage(member(), "prj_01", JPEG_WITH_GPS).thumbnailUrl;
    const stored = fs.readFileSync(path.join(dir, url.slice("/uploads/".length)));
    expect(has(stored, "GPS")).toBe(false);
    expectHttpError(() => setProjectImage(member(), "prj_01", Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 0x45, 0x78])), 415, "unsupported_image");
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

  it("refuses a signed-in outsider with 403 whatever they send, audits it, and writes no file first", () => {
    for (const bytes of [SVG, PNG]) expectHttpError(() => setProjectImage(nonMember(), "prj_01", bytes), 403, "not_your_project");
    expect(files()).toEqual([]);
    expect(auditRows().at(-1)!.action).toBe("authz.refused");
  });

  it("clearing or replacing the picture through the project form deletes the uploaded file; saving it unchanged keeps it", () => {
    const base = { title: "Glass Signal", summary: "s", trackId: "trk_04", repoUrl: "https://example.org/repo/01", status: "submitted" };
    const url = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: url });
    expect(files()).toEqual([url.slice("/uploads/".length)]);
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: "" });
    expect(files()).toEqual([]);
    setProjectImage(member(), "prj_01", JPEG);
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: "https://example.org/pic.png" });
    expect(files()).toEqual([]);
    expect(thumbnailOf("prj_01")).toBe("https://example.org/pic.png");
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

describe("another team's upload", () => {
  beforeEach(openEvent);
  const otherTeam = () => actorById(idByEmail("lena2@example.org")); // on tm_02, the team behind prj_02
  const prj02 = { title: "p2", summary: "s", trackId: "trk_03", repoUrl: "https://example.org/repo/02", status: "submitted" };
  const fileOf = (url: string) => url.slice("/uploads/".length);

  it("cannot be taken over by typing its address into your own project, so you cannot delete it either", () => {
    const theirs = setProjectImage(member(), "prj_01", PNG).thumbnailUrl; // its address shows on the public gallery card
    expectHttpError(() => updateProject(otherTeam(), "prj_02", { ...prj02, thumbnailUrl: theirs }), 422, "invalid");
    expect(thumbnailOf("prj_02")).not.toBe(theirs);
    expect(files()).toContain(fileOf(theirs));
  });

  it("cannot start a new project either", () => {
    const theirs = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    const newcomer = actorById(idByEmail("lena2@example.org"));
    h.sqlite.prepare("DELETE FROM team_members WHERE user_id = ?").run(newcomer.userId); // free to start a team
    createTeam(newcomer, "evt_01", { name: "Fresh Team" });
    expectHttpError(() => createProject(newcomer, "evt_01", { ...prj02, thumbnailUrl: theirs }), 422, "invalid");
  });

  it("is never deleted while another project still shows it", () => {
    const theirs = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    // however a second project came to hold the same address, taking its picture down keeps the file
    h.sqlite.prepare("UPDATE projects SET thumbnail_url = ? WHERE id = 'prj_02'").run(theirs);
    removeProjectImage(otherTeam(), "prj_02");
    expect(files()).toContain(fileOf(theirs));
    expect(thumbnailOf("prj_01")).toBe(theirs);
  });
});

describe("an organizer takes a picture down", () => {
  beforeEach(openEvent);
  const organizer = () => actorById("usr_organizer");
  const judge = () => actorById("jdg_24");

  it("takes an uploaded picture down with a reason in the audit log, and the file goes", () => {
    const url = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    const r = takeDownProjectImage(organizer(), "prj_01", { reason: "Not the project's picture" });
    expect(r.thumbnailUrl).toBeNull();
    expect(thumbnailOf("prj_01")).toBeNull();
    expect(files()).toEqual([]);
    const row = auditRows().at(-1)!;
    expect(row.action).toBe("project.image_taken_down");
    expect(row.before).toEqual({ thumbnailUrl: url });
    expect(row.after).toEqual({ thumbnailUrl: null, reason: "Not the project's picture" });
  });

  it("takes a linked picture down too, and works after submissions close", () => {
    h.sqlite.prepare("UPDATE projects SET thumbnail_url = 'https://example.org/bad.png' WHERE id = 'prj_01'").run();
    h.sqlite.prepare("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
    takeDownProjectImage(organizer(), "prj_01", { reason: "Offensive" });
    expect(thumbnailOf("prj_01")).toBeNull();
  });

  it("is refused to the team, a judge and a signed-out caller, and needs a reason", () => {
    setProjectImage(member(), "prj_01", PNG);
    expectHttpError(() => takeDownProjectImage(member(), "prj_01", { reason: "x" }), 403, "not_an_organizer");
    expectHttpError(() => takeDownProjectImage(judge(), "prj_01", { reason: "x" }), 403, "not_an_organizer");
    expectHttpError(() => takeDownProjectImage(null, "prj_01", { reason: "x" }), 401, "unauthenticated");
    expectHttpError(() => takeDownProjectImage(organizer(), "prj_01", { reason: " " }), 422, "invalid");
    expect(files()).toHaveLength(1);
  });

  it("is refused to a portal administrator who does not organize the event: changes stay with its organizers", () => {
    h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_admin2', 'admin2@example.org', 'Other Admin', NULL, 1, ?)").run(NOW);
    const admin = { ...actorById("usr_admin2"), isAdmin: true };
    setProjectImage(member(), "prj_01", PNG);
    expectHttpError(() => takeDownProjectImage(admin, "prj_01", { reason: "Offensive" }), 403, "not_an_organizer");
    expect(files()).toHaveLength(1);
  });

  it("with no picture to take down, changes nothing and writes no row", () => {
    h.sqlite.prepare("UPDATE projects SET thumbnail_url = NULL WHERE id = 'prj_01'").run();
    const rows = auditRows().length;
    takeDownProjectImage(organizer(), "prj_01", { reason: "Checking" });
    expect(auditRows().length).toBe(rows);
  });
});

describe("the fixtures.json export of an event with an uploaded picture", () => {
  it("writes the picture's full address, so the file imports again (the importer takes web addresses only)", () => {
    openEvent();
    const url = setProjectImage(member(), "prj_01", PNG).thumbnailUrl;
    const organizer = actorById("usr_organizer");
    const body = exportFile(organizer, "evt_01", "fixtures.json").body;
    const exported = (JSON.parse(body) as { projects: { id: string; thumbnail_url?: string }[] }).projects.find((p) => p.id === "prj_01")!;
    expect(exported.thumbnail_url).toBe(`http://localhost:8080${url}`);
    const file = path.join(os.tmpdir(), `export-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, body);
    try {
      expect(() => loadFixtureFile(file)).not.toThrow();
    } finally {
      fs.unlinkSync(file);
    }
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
