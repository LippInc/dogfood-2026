import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { exportFile } from "@/server/dal/exports";
import { latestAudit } from "@/server/dal/audit-log";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { addGalleryImage, setGallery, setProjectImage, takeDownGalleryImage } from "@/server/dal/project-image";
import { createProject, updateProject } from "@/server/dal/projects";
import { createTeam, dissolveTeam } from "@/server/dal/teams";
import { MAX_GALLERY_IMAGES } from "@/server/project-limits";
import { MAX_IMAGE_BYTES, sniffImage, sweepOrphanUploads } from "@/server/uploads";
import type { Actor } from "@/server/authz";

// The judge's-eye reading marked the portal down because a project's image gallery could only be linked. A team now
// uploads gallery images through the picture's own pipeline (kinds told by the bytes, 8 MB and 50 megapixels, drawn
// again as a WebP without metadata, the rule checked before the bytes and again with the write, audited), up to
// MAX_GALLERY_IMAGES, and reorders or removes them before the close; an organizer takes one down with a reason.

const NOW = "2026-09-28T02:00:00.000Z";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
  process.env.UPLOADS_DIR = dir;
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
  process.env.UPLOADS_DIR = saved;
});

function refusal(call: () => unknown): HttpError {
  try {
    call();
  } catch (err) {
    expect(err, "expected an HttpError").toBeInstanceOf(HttpError);
    return err as HttpError;
  }
  throw new Error("expected the call to be refused");
}
function expectHttpError(call: () => unknown, status: number, code: string) {
  const err = refusal(call);
  expect([err.status, err.code]).toEqual([status, code]);
}
async function expectRefused(call: Promise<unknown>, status: number, code: string) {
  const caught = await call.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(caught, "expected the call to be refused").toBeInstanceOf(HttpError);
  expect([(caught as HttpError).status, (caught as HttpError).code]).toEqual([status, code]);
}

function actorById(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const idByEmail = (email: string) => (h.sqlite.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
const member = () => actorById(idByEmail("member1_1@example.org")); // on tm_01, the team behind prj_01
const otherTeam = () => actorById(idByEmail("lena2@example.org")); // on tm_02, the team behind prj_02
const organizer = () => actorById("usr_organizer");
const judge = () => actorById("jdg_24");
const openEvent = () => h.sqlite.prepare("UPDATE events SET submissions_close_at = '2999-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
const closeEvent = () => h.sqlite.prepare("UPDATE events SET submissions_close_at = '2000-01-01T00:00:00Z' WHERE id = 'evt_01'").run();
const galleryOf = (id: string) => JSON.parse((h.sqlite.prepare("SELECT gallery_urls AS g FROM projects WHERE id = ?").get(id) as { g: string }).g) as string[];
const setGalleryRow = (id: string, list: string[]) => h.sqlite.prepare("UPDATE projects SET gallery_urls = ? WHERE id = ?").run(JSON.stringify(list), id);
const files = () => fs.readdirSync(dir).sort();
const fileOf = (url: string) => url.slice("/uploads/".length);
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();
const said = (l: { parts: { text: string }[] }) => l.parts.map((p) => p.text).join("");
const has = (b: Uint8Array, text: string) => Buffer.from(b).includes(Buffer.from(text, "latin1"));
const prj01Form = { title: "Glass Signal", summary: "s", trackId: "trk_04", repoUrl: "https://example.org/repo/01", status: "submitted" };

let PHOTO: Buffer;
let HUGE: Buffer;
beforeAll(async () => {
  PHOTO = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 40, g: 120, b: 200 } } })
    .jpeg()
    .withExif({ IFD0: { Artist: "Home Owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "59/1 26/1 0/1" } })
    .toBuffer();
  // a PNG whose header says 10000 x 10000 (100 megapixels): refused from the header, no pixels decoded
  HUGE = Buffer.from(await sharp({ create: { width: 10000, height: 10000, channels: 3, background: "#000" } }).png({ compressionLevel: 9 }).toBuffer());
});

describe("a team uploads gallery images while submissions are open", () => {
  beforeEach(openEvent);

  it("adds each upload to the end of the gallery, drawn again as a WebP, with an audit row per upload", async () => {
    setGalleryRow("prj_01", ["https://example.org/linked.png"]);
    const a = await addGalleryImage(member(), "prj_01", PNG);
    const b = await addGalleryImage(member(), "prj_01", PHOTO);
    expect(a.url).toMatch(/^\/uploads\/[A-Za-z0-9_-]{22}\.webp$/);
    expect(b.galleryUrls).toEqual(["https://example.org/linked.png", a.url, b.url]);
    expect(galleryOf("prj_01")).toEqual(b.galleryUrls);
    expect(files()).toEqual([fileOf(a.url), fileOf(b.url)].sort());
    for (const f of files()) expect(sniffImage(fs.readFileSync(path.join(dir, f)))).toBe("webp");
    const row = auditRows().at(-1)!;
    expect([row.action, row.targetId]).toEqual(["project.gallery", "prj_01"]);
    expect(row.before).toEqual({ galleryUrls: ["https://example.org/linked.png", a.url] });
    expect(row.after).toEqual({ galleryUrls: b.galleryUrls });
    expect(verifyAuditChain(h.db).ok).toBe(true);
    // the audit page says it in words
    expect(said(latestAudit(h.db, "evt_01", 5).find((l) => l.action === "project.gallery")!)).toMatch(/added an image to the gallery of/);
  });

  it("keeps nothing of a phone photo but its pixels", async () => {
    expect(has(PHOTO, "Home Owner")).toBe(true);
    const { url } = await addGalleryImage(member(), "prj_01", PHOTO);
    const stored = fs.readFileSync(path.join(dir, fileOf(url)));
    expect(has(stored, "Home Owner") || has(stored, "GPS")).toBe(false);
    expect((await sharp(stored).metadata()).exif).toBeUndefined();
  });

  it("refuses SVG, HTML and anything else with 415, over 8 MB or 50 megapixels with 413, and stores nothing", async () => {
    for (const bytes of [SVG, HTML, Buffer.from("hello"), PNG.subarray(0, 45)]) await expectRefused(addGalleryImage(member(), "prj_01", bytes), 415, "unsupported_image");
    await expectRefused(addGalleryImage(member(), "prj_01", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])), 413, "image_too_large");
    await expectRefused(addGalleryImage(member(), "prj_01", HUGE), 413, "image_too_large");
    expect(files()).toEqual([]);
    expect(galleryOf("prj_01")).toEqual([]);
  });

  it(`known-bad: a gallery holding ${MAX_GALLERY_IMAGES} images refuses the next with 409 gallery_full, before the file is looked at, and stores nothing`, async () => {
    for (let i = 0; i < MAX_GALLERY_IMAGES; i++) await addGalleryImage(member(), "prj_01", PNG);
    expect(files()).toHaveLength(MAX_GALLERY_IMAGES);
    await expectRefused(addGalleryImage(member(), "prj_01", PNG), 409, "gallery_full");
    await expectRefused(addGalleryImage(member(), "prj_01", SVG), 409, "gallery_full");
    expect(files()).toHaveLength(MAX_GALLERY_IMAGES);
    expect(galleryOf("prj_01")).toHaveLength(MAX_GALLERY_IMAGES);
  });

  it("checks the room again as it writes: a teammate filling the gallery while the picture is drawn leaves nothing", async () => {
    setGalleryRow("prj_01", Array.from({ length: MAX_GALLERY_IMAGES - 1 }, (_, i) => `https://example.org/${i}.png`));
    const pending = addGalleryImage(member(), "prj_01", PHOTO); // the first check passes now
    setGalleryRow("prj_01", Array.from({ length: MAX_GALLERY_IMAGES }, (_, i) => `https://example.org/${i}.png`));
    await expectRefused(pending, 409, "gallery_full");
    expect(files()).toEqual([]);
  });

  it("refuses another team's project with 403, audits the refusal, and writes no file", async () => {
    const was = auditRows().filter((r) => r.action === "authz.refused").length;
    for (const bytes of [PNG, SVG]) await expectRefused(addGalleryImage(otherTeam(), "prj_01", bytes), 403, "not_your_project");
    expect(auditRows().filter((r) => r.action === "authz.refused").length - was).toBe(2);
    expect(files()).toEqual([]);
    expect(galleryOf("prj_01")).toEqual([]);
    // positive control: the same person uploads to their own team's project
    expect((await addGalleryImage(otherTeam(), "prj_02", PNG)).galleryUrls).toHaveLength(1);
  });

  it("refuses no session with 401, no file and no audit row; a judge and the organizer with 403", async () => {
    const rows = auditRows().length;
    await expectRefused(addGalleryImage(null, "prj_01", PNG), 401, "unauthenticated");
    expect(auditRows().length).toBe(rows);
    await expectRefused(addGalleryImage(judge(), "prj_01", PNG), 403, "not_your_project");
    await expectRefused(addGalleryImage(organizer(), "prj_01", PNG), 403, "not_your_project");
    await expectRefused(addGalleryImage(member(), "prj_nope", PNG), 404, "not_found");
    expect(files()).toEqual([]);
  });
});

describe("after submissions close", () => {
  it("an upload is 403 submissions_closed, as the picture's, and leaves no file", async () => {
    closeEvent();
    await expectRefused(addGalleryImage(member(), "prj_01", PNG), 403, "submissions_closed");
    expect(files()).toEqual([]);
  });

  it("submissions closing while the picture is drawn leave nothing", async () => {
    openEvent();
    const pending = addGalleryImage(member(), "prj_01", PHOTO);
    closeEvent();
    await expectRefused(pending, 403, "submissions_closed");
    expect(files()).toEqual([]);
    expect(galleryOf("prj_01")).toEqual([]);
  });

  it("reordering or removing is 403 submissions_closed and deletes no file", async () => {
    openEvent();
    const { url } = await addGalleryImage(member(), "prj_01", PNG);
    closeEvent();
    expectHttpError(() => setGallery(member(), "prj_01", { galleryUrls: [] }), 403, "submissions_closed");
    expect(files()).toEqual([fileOf(url)]);
    expect(galleryOf("prj_01")).toEqual([url]);
  });
});

describe("the team reorders, removes and links", () => {
  beforeEach(openEvent);

  it("reorders the gallery, with an audit row saying so; the same list again writes nothing", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const b = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const r = setGallery(member(), "prj_01", { galleryUrls: [b, a] });
    expect(r.galleryUrls).toEqual([b, a]);
    expect(galleryOf("prj_01")).toEqual([b, a]);
    expect(auditRows().at(-1)).toMatchObject({ action: "project.gallery", before: { galleryUrls: [a, b] }, after: { galleryUrls: [b, a] } });
    expect(said(latestAudit(h.db, "evt_01", 1)[0]!)).toMatch(/reordered the gallery of/);
    const rows = auditRows().length;
    setGallery(member(), "prj_01", { galleryUrls: [b, a] });
    expect(auditRows().length).toBe(rows);
    expect(files()).toHaveLength(2);
  });

  it("removing an upload deletes its file after the commit; a link can be added", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const b = (await addGalleryImage(member(), "prj_01", PNG)).url;
    setGallery(member(), "prj_01", { galleryUrls: [b, "https://example.org/shot.png"] });
    expect(galleryOf("prj_01")).toEqual([b, "https://example.org/shot.png"]);
    expect(files()).toEqual([fileOf(b)]);
    expect(said(latestAudit(h.db, "evt_01", 1)[0]!)).toMatch(/changed the gallery of/);
    setGallery(member(), "prj_01", { galleryUrls: [] });
    expect(files()).toEqual([]);
    void a;
  });

  it("known-bad: another project's upload cannot be typed into a gallery (422 by the gallery route or a new project; a project edit ignores the list), so it cannot be deleted either", async () => {
    const theirs = (await addGalleryImage(member(), "prj_01", PNG)).url; // public on prj_01's page
    const prj02 = { title: "p2", summary: "s", trackId: "trk_03", repoUrl: "https://example.org/repo/02", status: "submitted" };
    const e1 = refusal(() => setGallery(otherTeam(), "prj_02", { galleryUrls: [theirs] }));
    expect([e1.status, e1.code]).toEqual([422, "invalid"]);
    expect(e1.details).toMatchObject({ galleryUrls: [expect.stringMatching(/Use Upload/)] });
    updateProject(otherTeam(), "prj_02", { ...prj02, galleryUrls: [theirs] });
    expect(galleryOf("prj_02")).not.toContain(theirs);
    // their own picture's upload cannot be moved into the gallery by typing either
    const picture = (await setProjectImage(member(), "prj_01", PNG)).thumbnailUrl;
    expectHttpError(() => setGallery(member(), "prj_01", { galleryUrls: [theirs, picture] }), 422, "invalid");
    expect(galleryOf("prj_02")).not.toContain(theirs);
    expect(files()).toContain(fileOf(theirs));
    // and a new project cannot start with one
    const newcomer = otherTeam();
    h.sqlite.prepare("DELETE FROM team_members WHERE user_id = ?").run(newcomer.userId);
    createTeam(newcomer, "evt_01", { name: "Fresh Team" });
    expectHttpError(() => createProject(newcomer, "evt_01", { ...prj02, galleryUrls: [theirs] }), 422, "invalid");
  });

  it("refuses anything but a web address or the gallery's own upload: paths, other schemes, more than the limit", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    for (const bad of ["/uploads/../portal.db", "/etc/passwd", "/uploads/short.png", "javascript:alert(1)", "data:image/png;base64,AAAA"])
      expectHttpError(() => setGallery(member(), "prj_01", { galleryUrls: [a, bad] }), 422, "invalid");
    const seven = Array.from({ length: MAX_GALLERY_IMAGES + 1 }, (_, i) => `https://example.org/${i}.png`);
    expectHttpError(() => setGallery(member(), "prj_01", { galleryUrls: seven }), 422, "invalid");
    expectHttpError(() => setGallery(member(), "prj_01", {}), 422, "invalid");
    expect(galleryOf("prj_01")).toEqual([a]);
    // the same address twice is kept once
    expect(setGallery(member(), "prj_01", { galleryUrls: [a, a, "https://example.org/x.png", "https://example.org/x.png"] }).galleryUrls).toEqual([a, "https://example.org/x.png"]);
  });

  it("known-bad: a stale page (expected is not the stored list) is 409 gallery_changed and removes nothing; the current list passes", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const seen = [a];
    const b = (await addGalleryImage(member(), "prj_01", PNG)).url; // a teammate's upload, not on the first page
    expectHttpError(() => setGallery(member(), "prj_01", { galleryUrls: [], expected: seen }), 409, "gallery_changed");
    expect(files()).toEqual([fileOf(a), fileOf(b)].sort());
    expect(setGallery(member(), "prj_01", { galleryUrls: [b], expected: [a, b] }).galleryUrls).toEqual([b]);
    expect(files()).toEqual([fileOf(b)]);
  });

  it("refuses another team (403, audited), a judge (403) and no session (401)", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    expectHttpError(() => setGallery(otherTeam(), "prj_01", { galleryUrls: [] }), 403, "not_your_project");
    expect(auditRows().at(-1)!.action).toBe("authz.refused");
    expectHttpError(() => setGallery(judge(), "prj_01", { galleryUrls: [] }), 403, "not_your_project");
    expectHttpError(() => setGallery(null, "prj_01", { galleryUrls: [] }), 401, "unauthenticated");
    expect(galleryOf("prj_01")).toEqual([a]);
    expect(files()).toEqual([fileOf(a)]);
  });

  it("the gallery route takes the uploads back in any order; leaving one out, against the list the page showed, deletes it", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const b = (await addGalleryImage(member(), "prj_01", PNG)).url;
    setGallery(member(), "prj_01", { galleryUrls: [b, a], expected: [a, b] });
    expect(galleryOf("prj_01")).toEqual([b, a]);
    expect(files()).toHaveLength(2);
    setGallery(member(), "prj_01", { galleryUrls: [a], expected: [b, a] });
    expect(galleryOf("prj_01")).toEqual([a]);
    expect(files()).toEqual([fileOf(a)]);
  });

  it("a file another project still shows is never deleted", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    // however a second project came to hold the same address (an operator's copy, say), removing it here keeps the file
    setGalleryRow("prj_02", [a]);
    setGallery(member(), "prj_01", { galleryUrls: [] });
    expect(files()).toEqual([fileOf(a)]);
  });
});

// A teammate's page stays open while the gallery changes under it (a teammate uploads or removes an image, an
// organizer takes one down). Once the project exists the gallery changes only through its own route, which checks
// the list the page last saw (409 gallery_changed); a project Save never names it, so a stale Save can neither delete
// a teammate's upload nor be refused for naming one that is gone, nor bring a taken-down image back.
describe("a stale project Save leaves the gallery as stored", () => {
  beforeEach(openEvent);
  const teammate = () => actorById(idByEmail("member1_2@example.org")); // also on tm_01

  it("known-bad: a teammate's upload between page load and Save survives the Save, file and gallery row", async () => {
    const x = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const seen = galleryOf("prj_01"); // A's page draws [x]
    const y = (await addGalleryImage(teammate(), "prj_01", PNG)).url; // B uploads y
    updateProject(member(), "prj_01", { ...prj01Form, summary: "edited by A", galleryUrls: seen });
    expect(galleryOf("prj_01")).toEqual([x, y]);
    expect(files()).toEqual([fileOf(x), fileOf(y)].sort());
    const row = auditRows().at(-1)!;
    expect(row.action).toBe("project.update");
    expect(row.after).toMatchObject({ summary: "edited by A" });
    expect(row.after).not.toHaveProperty("galleryUrls");
    // a Save with no gallery at all (the form after the fix) keeps it too
    updateProject(member(), "prj_01", { ...prj01Form, summary: "again" });
    expect(galleryOf("prj_01")).toEqual([x, y]);
    expect(files()).toEqual([fileOf(x), fileOf(y)].sort());
  });

  it("a stale Save after a teammate removed an upload saves the other fields: no 422, no image brought back", async () => {
    const x = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const y = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const seen = galleryOf("prj_01"); // A's page draws [x, y]
    setGallery(teammate(), "prj_01", { galleryUrls: [x], expected: [x, y] }); // B removes y
    expect(files()).toEqual([fileOf(x)]);
    const saved = updateProject(member(), "prj_01", { ...prj01Form, summary: "edited by A", galleryUrls: seen });
    expect(saved.status).toBe("submitted");
    expect(h.sqlite.prepare("SELECT summary FROM projects WHERE id = 'prj_01'").get()).toEqual({ summary: "edited by A" });
    expect(galleryOf("prj_01")).toEqual([x]);
    expect(files()).toEqual([fileOf(x)]);
  });

  it("an organizer's take-down between page load and Save stays taken down", async () => {
    const x = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const y = (await addGalleryImage(member(), "prj_01", PNG)).url;
    setGalleryRow("prj_01", [x, y, "https://example.org/linked.png"]);
    const seen = galleryOf("prj_01");
    takeDownGalleryImage(organizer(), "prj_01", { reason: "Not this project's image", galleryUrl: x });
    takeDownGalleryImage(organizer(), "prj_01", { reason: "Offensive", galleryUrl: "https://example.org/linked.png" });
    updateProject(member(), "prj_01", { ...prj01Form, summary: "edited by A", galleryUrls: seen });
    expect(galleryOf("prj_01")).toEqual([y]);
    expect(files()).toEqual([fileOf(y)]);
  });

  it("a project update never sets the gallery, not even with the current list reordered or a link added", async () => {
    const x = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const y = (await addGalleryImage(member(), "prj_01", PNG)).url;
    updateProject(member(), "prj_01", { ...prj01Form, galleryUrls: [y, x, "https://example.org/new.png"] });
    expect(galleryOf("prj_01")).toEqual([x, y]);
    updateProject(member(), "prj_01", { ...prj01Form, galleryUrls: [] });
    expect(galleryOf("prj_01")).toEqual([x, y]);
    expect(files()).toEqual([fileOf(x), fileOf(y)].sort());
    // positive control: the same change through the gallery route takes
    expect(setGallery(member(), "prj_01", { galleryUrls: [y, x, "https://example.org/new.png"], expected: [x, y] }).galleryUrls).toEqual([y, x, "https://example.org/new.png"]);
  });
});

describe("an organizer takes a gallery image down", () => {
  beforeEach(openEvent);

  it("with a reason in the audit log, at any time; an upload's file goes, a link just leaves the list", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    setGalleryRow("prj_01", [a, "https://example.org/bad.png"]);
    closeEvent();
    const r = takeDownGalleryImage(organizer(), "prj_01", { reason: "Not this project's image", galleryUrl: a });
    expect(r.galleryUrls).toEqual(["https://example.org/bad.png"]);
    expect(files()).toEqual([]);
    expect(auditRows().at(-1)).toMatchObject({
      action: "project.gallery_image_taken_down",
      before: { galleryUrls: [a, "https://example.org/bad.png"] },
      after: { galleryUrls: ["https://example.org/bad.png"], removed: a, reason: "Not this project's image" },
    });
    expect(said(latestAudit(h.db, "evt_01", 1)[0]!)).toMatch(/took an image out of the gallery of .*Not this project/);
    takeDownGalleryImage(organizer(), "prj_01", { reason: "Offensive", galleryUrl: "https://example.org/bad.png" });
    expect(galleryOf("prj_01")).toEqual([]);
  });

  it("is refused to the team, a judge and a signed-out caller, needs a reason, and 404s an image the gallery does not hold", async () => {
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    expectHttpError(() => takeDownGalleryImage(member(), "prj_01", { reason: "mine", galleryUrl: a }), 403, "not_an_organizer");
    expectHttpError(() => takeDownGalleryImage(judge(), "prj_01", { reason: "nope", galleryUrl: a }), 403, "not_an_organizer");
    expectHttpError(() => takeDownGalleryImage(null, "prj_01", { reason: "nope", galleryUrl: a }), 401, "unauthenticated");
    expectHttpError(() => takeDownGalleryImage(organizer(), "prj_01", { reason: " ", galleryUrl: a }), 422, "invalid");
    expectHttpError(() => takeDownGalleryImage(organizer(), "prj_01", { reason: "Offensive" }), 422, "invalid");
    expectHttpError(() => takeDownGalleryImage(organizer(), "prj_01", { reason: "Offensive", galleryUrl: "https://example.org/other.png" }), 404, "not_found");
    expect(files()).toEqual([fileOf(a)]);
    expect(galleryOf("prj_01")).toEqual([a]);
  });
});

describe("the files around it", () => {
  it("the fixtures.json export writes an uploaded gallery image's full address, which imports again", async () => {
    openEvent();
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    setGalleryRow("prj_01", [a, "https://example.org/linked.png"]);
    const body = exportFile(organizer(), "evt_01", "fixtures.json").body;
    const exported = (JSON.parse(body) as { projects: { id: string; gallery_urls?: string[] }[] }).projects.find((p) => p.id === "prj_01")!;
    expect(exported.gallery_urls).toEqual([`http://localhost:8080${a}`, "https://example.org/linked.png"]);
    const file = path.join(os.tmpdir(), `gallery-export-${process.pid}-${Date.now()}.json`);
    fs.writeFileSync(file, body);
    try {
      expect(() => loadFixtureFile(file)).not.toThrow();
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("the start-up sweep keeps a gallery's uploads and removes one no project names any more", async () => {
    openEvent();
    const a = (await addGalleryImage(member(), "prj_01", PNG)).url;
    const b = (await addGalleryImage(member(), "prj_01", PNG)).url;
    setGalleryRow("prj_01", [a]); // as a crash between the commit and the delete would leave it
    expect(sweepOrphanUploads(h.db, dir)).toEqual({ removed: 1, kept: 1 });
    expect(files()).toEqual([fileOf(a)]);
    void b;
  });

  it("a team dissolved with its draft takes the draft's gallery uploads with it", async () => {
    openEvent();
    h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_solo', 'solo@example.org', 'Solo', NULL, 0, ?)").run(NOW);
    const teamId = createTeam(actorById("usr_solo"), "evt_01", { name: "Draft Team" }).id;
    const draft = createProject(actorById("usr_solo"), "evt_01", { title: "Half Done", trackId: "trk_01", status: "draft" });
    await addGalleryImage(actorById("usr_solo"), draft.id, PNG);
    await setProjectImage(actorById("usr_solo"), draft.id, PNG);
    expect(files()).toHaveLength(2);
    dissolveTeam(actorById("usr_solo"), teamId);
    expect(files()).toEqual([]);
  });
});
