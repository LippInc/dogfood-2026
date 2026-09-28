import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { MAX_IMAGE_BYTES, readUpload, redrawImage, sniffImage } from "@/server/uploads";
import type { Actor } from "@/server/authz";

// Every judge's-eye reading marked the portal down for having no uploads: a team could only point at an
// image on its own host. A team member now uploads the project's picture; the portal keeps it in the data
// volume next to the database. Only PNG, JPEG and WebP, told by their first bytes (never by a name or a
// declared type, so no SVG or HTML is ever decoded), at most 8 MB and 50 megapixels, only by the team while
// submissions are open, through the one data access layer with its audit row; what is stored is the picture
// drawn again from its pixels as a WebP, so nothing else in the file survives; a refused upload leaves no file.

const NOW = "2026-09-28T02:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
// the smallest well-formed JPEG stream: start, a JFIF header with its right length, end; it has no pixels to draw
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

async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const caught = await call.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught, "expected the call to be refused").toBeInstanceOf(HttpError);
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

// Phone photos carry where they were taken; a picture here is public, so nothing but the pixels is kept.
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
  return Buffer.concat([len, Buffer.from(type, "latin1"), data, crc]);
};
// a PNG header for 10000 x 10000 pixels (100 megapixels) and no pixels after it
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(10000, 0);
ihdr.writeUInt32BE(10000, 4);
ihdr.set([8, 2, 0, 0, 0], 8);
const HUGE = Buffer.concat([PNG.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", Buffer.alloc(0)), chunk("IEND", Buffer.alloc(0))]);
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
// a well-formed WebP container (RIFF, its size, WEBP, one image chunk) with no real pixels in it
const WEBP = webp(riffChunk("VP8L", Buffer.alloc(14, 7)));
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));

// Real pictures, made here: a 64 x 32 photo taken with the phone held sideways (orientation 6, so it shows
// 32 x 64), with who took it and where in its EXIF, a content-credentials record (APP11) and a motion
// photo's video after its end; the same EXIF in a WebP; a PNG with that EXIF and a text chunk saying where.
let PHOTO: Buffer;
let WEBP_PHOTO: Buffer;
let PNG_WITH_TEXT: Buffer;
beforeAll(async () => {
  const red = () => sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 40, b: 40 } } });
  const exif = { IFD0: { Artist: "Home Owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "59/1 26/1 0/1" } };
  const jpeg = await red().jpeg().withMetadata({ orientation: 6 }).withExif(exif).toBuffer();
  PHOTO = Buffer.concat([jpeg.subarray(0, 2), seg(0xeb, Buffer.from("JP c2pa GPS 59.43N 24.75E", "latin1")), jpeg.subarray(2), Buffer.from("ftypmp42 MOTION GPS 59.43N 24.75E", "latin1")]);
  WEBP_PHOTO = await red().webp().withExif(exif).toBuffer();
  const png = await red().png().withExif(exif).toBuffer();
  PNG_WITH_TEXT = Buffer.concat([png.subarray(0, 33), chunk("tEXt", Buffer.from("Comment\0GPS 59.43N 24.75E", "latin1")), png.subarray(33)]);
});

describe("redrawImage", () => {
  it("draws a phone photo upright as a WebP that holds nothing of the file but its pixels", async () => {
    // the fixture holds what it should, so the checks below cannot pass on an empty one
    const before = await sharp(PHOTO).metadata();
    expect([before.width, before.height, before.orientation, Boolean(before.exif)]).toEqual([64, 32, 6, true]);
    for (const text of ["Home Owner", "c2pa GPS", "MOTION GPS"]) expect(has(PHOTO, text)).toBe(true);
    const r = await redrawImage(PHOTO);
    if (!r.ok) throw new Error(r.why);
    expect(sniffImage(r.bytes)).toBe("webp");
    const after = await sharp(r.bytes).metadata();
    expect([after.width, after.height, after.orientation, after.exif, after.xmp, after.icc]).toEqual([32, 64, undefined, undefined, undefined, undefined]);
    for (const text of ["Home Owner", "GPS", "MOTION", "c2pa"]) expect(has(r.bytes, text)).toBe(false);
  });

  it("keeps no EXIF or text from a PNG or a WebP", async () => {
    for (const input of [PNG_WITH_TEXT, WEBP_PHOTO]) {
      expect(has(input, "Home Owner")).toBe(true);
      const r = await redrawImage(input);
      if (!r.ok) throw new Error(r.why);
      expect(sniffImage(r.bytes)).toBe("webp");
      expect(has(r.bytes, "Home Owner") || has(r.bytes, "GPS")).toBe(false);
      expect((await sharp(r.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it("scales a large picture to 1600 pixels on its longest side and leaves a small one its size", async () => {
    const wide = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: "#123456" } }).png().toBuffer();
    const big = await redrawImage(wide);
    const small = await redrawImage(PNG);
    if (!big.ok || !small.ok) throw new Error("not drawn");
    const [b, s] = [await sharp(big.bytes).metadata(), await sharp(small.bytes).metadata()];
    expect([b.width, b.height, s.width, s.height]).toEqual([1600, 400, 1, 1]);
  });

  it("refuses a picture over 50 megapixels from its header, before any pixel is decoded", async () => {
    expect(await redrawImage(HUGE)).toEqual({ ok: false, why: "too_many_pixels" });
  });

  it("gives damaged for a file that does not decode", async () => {
    expect(await redrawImage(JPEG)).toEqual({ ok: false, why: "damaged" });
    expect(await redrawImage(WEBP)).toEqual({ ok: false, why: "damaged" });
    expect(await redrawImage(PNG.subarray(0, 45))).toEqual({ ok: false, why: "damaged" });
  });
});

describe("setProjectImage with the event open", () => {
  beforeEach(openEvent);

  it("stores a team member's picture, drawn again as a WebP, and makes it the project's picture, with its audit row", async () => {
    const before = thumbnailOf("prj_01");
    const r = await setProjectImage(member(), "prj_01", PNG);
    expect(r.thumbnailUrl).toMatch(/^\/uploads\/[A-Za-z0-9_-]{22}\.webp$/);
    expect(thumbnailOf("prj_01")).toBe(r.thumbnailUrl);
    expect(files()).toEqual([r.thumbnailUrl.slice("/uploads/".length)]);
    expect(sniffImage(fs.readFileSync(path.join(dir, files()[0]!)))).toBe("webp");
    const row = auditRows().at(-1)!;
    expect(row.action).toBe("project.image");
    expect(row.targetId).toBe("prj_01");
    expect(row.after).toEqual({ thumbnailUrl: r.thumbnailUrl });
    expect(row.before).toEqual({ thumbnailUrl: before });
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("stores a phone photo upright and without where it was taken, and refuses one that does not decode", async () => {
    const url = (await setProjectImage(member(), "prj_01", PHOTO)).thumbnailUrl;
    const stored = fs.readFileSync(path.join(dir, url.slice("/uploads/".length)));
    for (const text of ["Home Owner", "GPS", "MOTION"]) expect(has(stored, text)).toBe(false);
    const shown = await sharp(stored).metadata();
    expect([shown.width, shown.height]).toEqual([32, 64]);
    await expectRefused(setProjectImage(member(), "prj_01", JPEG), 415, "unsupported_image");
  });

  it("stores JPEG and WebP as a WebP too", async () => {
    expect((await setProjectImage(member(), "prj_01", PHOTO)).thumbnailUrl).toMatch(/\.webp$/);
    expect((await setProjectImage(member(), "prj_01", WEBP_PHOTO)).thumbnailUrl).toMatch(/\.webp$/);
  });

  it("refuses SVG, HTML and anything else with 415, and stores nothing", async () => {
    const before = thumbnailOf("prj_01");
    for (const bytes of [SVG, HTML, Buffer.from("hello")]) await expectRefused(setProjectImage(member(), "prj_01", bytes), 415, "unsupported_image");
    expect(files()).toEqual([]);
    expect(thumbnailOf("prj_01")).toBe(before);
  });

  it("refuses an image over 8 MB, or over 50 megapixels, with 413, and stores nothing", async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    await expectRefused(setProjectImage(member(), "prj_01", big), 413, "image_too_large");
    await expectRefused(setProjectImage(member(), "prj_01", HUGE), 413, "image_too_large");
    expect(files()).toEqual([]);
  });

  it("refuses someone not on the team with 403, audits the refusal once, and leaves no file behind", async () => {
    const before = thumbnailOf("prj_01");
    const refusals = () => auditRows().filter((r) => r.action === "authz.refused").length;
    const was = refusals();
    await expectRefused(setProjectImage(nonMember(), "prj_01", PNG), 403, "not_your_project");
    expect(files()).toEqual([]);
    expect(thumbnailOf("prj_01")).toBe(before);
    expect(auditRows().at(-1)!.action).toBe("authz.refused");
    expect(refusals() - was).toBe(1);
  });

  it("refuses no session with 401, no file and no audit row", async () => {
    const rows = auditRows().length;
    await expectRefused(setProjectImage(null, "prj_01", PNG), 401, "unauthenticated");
    expect(files()).toEqual([]);
    expect(auditRows().length).toBe(rows);
  });

  it("checks the rule again as it writes: submissions closing while the picture is drawn leave nothing", async () => {
    const pending = setProjectImage(member(), "prj_01", PHOTO); // the first check passes now
    h.sqlite.prepare("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
    await expectRefused(pending, 403, "submissions_closed");
    expect(files()).toEqual([]);
  });

  it("a new picture replaces the old upload's file, and removing the picture deletes it", async () => {
    const first = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
    const second = (await setProjectImage(member(), "prj_01", PHOTO)).thumbnailUrl;
    expect(files()).toEqual([second.slice("/uploads/".length)]);
    expect(first).not.toBe(second);
    const r = removeProjectImage(member(), "prj_01");
    expect(r.thumbnailUrl).toBeNull();
    expect(thumbnailOf("prj_01")).toBeNull();
    expect(files()).toEqual([]);
    expect(auditRows().at(-1)!.action).toBe("project.image");
  });

  it("refuses a signed-in outsider with 403 whatever they send, audits it, and writes no file first", async () => {
    for (const bytes of [SVG, PNG, HUGE]) await expectRefused(setProjectImage(nonMember(), "prj_01", bytes), 403, "not_your_project");
    expect(files()).toEqual([]);
    expect(auditRows().at(-1)!.action).toBe("authz.refused");
  });

  it("clearing or replacing the picture through the project form deletes the uploaded file; saving it unchanged keeps it", async () => {
    const base = { title: "Glass Signal", summary: "s", trackId: "trk_04", repoUrl: "https://example.org/repo/01", status: "submitted" };
    const url = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: url });
    expect(files()).toEqual([url.slice("/uploads/".length)]);
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: "" });
    expect(files()).toEqual([]);
    await setProjectImage(member(), "prj_01", PHOTO);
    updateProject(member(), "prj_01", { ...base, thumbnailUrl: "https://example.org/pic.png" });
    expect(files()).toEqual([]);
    expect(thumbnailOf("prj_01")).toBe("https://example.org/pic.png");
  });

  it("the project form can send the uploaded picture back unchanged, but no other local path", async () => {
    const url = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
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

  it("cannot be taken over by typing its address into your own project, so you cannot delete it either", async () => {
    const theirs = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl; // its address shows on the public gallery card
    expectHttpError(() => updateProject(otherTeam(), "prj_02", { ...prj02, thumbnailUrl: theirs }), 422, "invalid");
    expect(thumbnailOf("prj_02")).not.toBe(theirs);
    expect(files()).toContain(fileOf(theirs));
  });

  it("cannot start a new project either", async () => {
    const theirs = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
    const newcomer = actorById(idByEmail("lena2@example.org"));
    h.sqlite.prepare("DELETE FROM team_members WHERE user_id = ?").run(newcomer.userId); // free to start a team
    createTeam(newcomer, "evt_01", { name: "Fresh Team" });
    expectHttpError(() => createProject(newcomer, "evt_01", { ...prj02, thumbnailUrl: theirs }), 422, "invalid");
  });

  it("is never deleted while another project still shows it", async () => {
    const theirs = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
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

  it("takes an uploaded picture down with a reason in the audit log, and the file goes", async () => {
    const url = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
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

  it("is refused to the team, a judge and a signed-out caller, and needs a reason", async () => {
    await setProjectImage(member(), "prj_01", PNG);
    expectHttpError(() => takeDownProjectImage(member(), "prj_01", { reason: "x" }), 403, "not_an_organizer");
    expectHttpError(() => takeDownProjectImage(judge(), "prj_01", { reason: "x" }), 403, "not_an_organizer");
    expectHttpError(() => takeDownProjectImage(null, "prj_01", { reason: "x" }), 401, "unauthenticated");
    expectHttpError(() => takeDownProjectImage(organizer(), "prj_01", { reason: " " }), 422, "invalid");
    expect(files()).toHaveLength(1);
  });

  it("is refused to a portal administrator who does not organize the event: changes stay with its organizers", async () => {
    h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_admin2', 'admin2@example.org', 'Other Admin', NULL, 1, ?)").run(NOW);
    const admin = { ...actorById("usr_admin2"), isAdmin: true };
    await setProjectImage(member(), "prj_01", PNG);
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
  it("writes the picture's full address, so the file imports again (the importer takes web addresses only)", async () => {
    openEvent();
    const url = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
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
  it("refuses a team member with 403 submissions_closed, and leaves no file behind", async () => {
    await expectRefused(setProjectImage(member(), "prj_01", PNG), 403, "submissions_closed");
    expect(files()).toEqual([]);
  });
});

describe("readUpload", () => {
  it("serves only well-formed names from the uploads folder, with the type the name says", async () => {
    openEvent();
    const url = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
    const got = readUpload(url.slice("/uploads/".length));
    expect(got?.type).toBe("image/webp");
    expect(got?.bytes.equals(fs.readFileSync(path.join(dir, files()[0]!)))).toBe(true);
    for (const bad of ["../portal.db", "..%2Fportal.db", "x.png", `${"a".repeat(22)}.svg`, `${"a".repeat(22)}.png`]) expect(readUpload(bad)).toBeNull();
  });
});
