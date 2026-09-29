import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { FixtureSchema, importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { auditLog, events, projects } from "@/server/db/schema";
import { getGallery } from "@/server/dal/events";
import { exportFile } from "@/server/dal/exports";
import { setGallery } from "@/server/dal/project-image";
import { getPublicProject, updateProject } from "@/server/dal/projects";
import { actorForToken } from "@/server/session";

// The event page's reference field set (T1) includes a thumbnail, an image gallery
// and tech tags. They are stored, shown, validated (http and https only, at most 6
// images and 8 tags) and carried through the fixtures.json export and import. A saved
// project's gallery is set through its own route (setGallery), never by the project Save.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function checker(label: "organizer" | "participant") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
}

function outcome(fn: () => unknown): { status: number; fields?: string[] } {
  try {
    fn();
    return { status: 200 };
  } catch (err) {
    const e = err as { status?: number; details?: Record<string, unknown> };
    return { status: e.status ?? 500, fields: e.details ? Object.keys(e.details) : undefined };
  }
}

const prj01 = () => h.db.select().from(projects).where(eq(projects.id, "prj_01")).get()!;
function body(extra: Record<string, unknown>) {
  const p = prj01();
  return { title: p.title, summary: p.summary, description: p.description, trackId: p.trackId, repoUrl: p.repoUrl ?? "", status: "submitted", ...extra };
}

beforeEach(() => {
  process.env.SEED_CHECKER_SESSIONS = "true";
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  // Submissions open again, so the participant can edit the project.
  h.db.update(events).set({ submissionsCloseAt: "2099-01-01T00:00:00.000Z" }).where(eq(events.id, "evt_01")).run();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  process.env.SEED_CHECKER_SESSIONS = saved.flag;
});

describe("thumbnail, image gallery and tech tags", () => {
  const images = ["https://img.example.org/1.png", "https://img.example.org/2.png"];

  it("are stored, shown on the project page and the gallery, and audited; tags are trimmed and kept once whatever their case", () => {
    const participant = checker("participant");
    updateProject(participant, "prj_01", body({ thumbnailUrl: "https://img.example.org/cover.png", tags: ["Rust", "rust", " WebGPU "] }));
    setGallery(participant, "prj_01", { galleryUrls: images, expected: [] });

    expect(prj01()).toMatchObject({ thumbnailUrl: "https://img.example.org/cover.png", galleryUrls: images, tags: ["Rust", "WebGPU"] });
    const shown = getPublicProject("evt_01", "prj_01").project;
    expect(shown).toMatchObject({ thumbnailUrl: "https://img.example.org/cover.png", galleryUrls: images, tags: ["Rust", "WebGPU"] });
    const card = getGallery("evt_01").projects.find((p) => p.id === "prj_01")!;
    expect(card).toMatchObject({ thumbnailUrl: "https://img.example.org/cover.png", tags: ["Rust", "WebGPU"] });
    const row = h.db.select().from(auditLog).where(eq(auditLog.action, "project.update")).orderBy(desc(auditLog.id)).get()!;
    expect(row.after).toMatchObject({ tags: ["Rust", "WebGPU"] });
    const gallery = h.db.select().from(auditLog).where(eq(auditLog.action, "project.gallery")).orderBy(desc(auditLog.id)).get()!;
    expect(gallery.after).toEqual({ galleryUrls: images });

    // Saving the same lists again changes nothing, so the audit row names no list.
    updateProject(participant, "prj_01", body({ thumbnailUrl: "https://img.example.org/cover.png", galleryUrls: images, tags: ["Rust", "WebGPU"], title: "Glass Signal 2" }));
    const again = h.db.select().from(auditLog).where(eq(auditLog.action, "project.update")).orderBy(desc(auditLog.id)).get()!;
    expect(Object.keys(again.after as object)).toEqual(["title"]);
  });

  it("refuses non-web addresses, a seventh image, a ninth tag and a long tag with 422 on the field; eight distinct tags among repeats pass", () => {
    const participant = checker("participant");
    const refused = [
      body({ thumbnailUrl: "javascript:alert(1)" }),
      body({ tags: Array.from({ length: 9 }, (_, n) => `tag${n}`) }),
      body({ tags: ["x".repeat(41)] }),
    ];
    const fields = ["thumbnailUrl", "tags", "tags"];
    refused.forEach((b, n) => expect(outcome(() => updateProject(participant, "prj_01", b))).toEqual({ status: 422, fields: [fields[n]] }));
    expect(prj01().tags).toEqual([]);
    for (const list of [["data:image/png;base64,AAAA"], Array.from({ length: 7 }, (_, n) => `https://img.example.org/${n}.png`)])
      expect(outcome(() => setGallery(participant, "prj_01", { galleryUrls: list }))).toEqual({ status: 422, fields: ["galleryUrls"] });
    expect(prj01().galleryUrls).toEqual([]);

    const eight = Array.from({ length: 8 }, (_, n) => `tag${n}`);
    expect(outcome(() => updateProject(participant, "prj_01", body({ tags: [...eight, "TAG0", "Tag1"] }))).status).toBe(200);
    expect(prj01().tags).toEqual(eight);

    // A real tag longer than the old 24-character cap, and one at the new cap of 40, pass.
    const long = ["human-computer-interaction", "y".repeat(40)];
    expect(outcome(() => updateProject(participant, "prj_01", body({ tags: long }))).status).toBe(200);
    expect(prj01().tags).toEqual(long);
  });

  it("travel through the fixtures.json export and import, and fixture projects without them export as before", () => {
    updateProject(checker("participant"), "prj_01", body({ thumbnailUrl: "https://img.example.org/cover.png", tags: ["Rust", "human-computer-interaction"] }));
    setGallery(checker("participant"), "prj_01", { galleryUrls: images });
    const exported = JSON.parse(exportFile(checker("organizer"), "evt_01", "fixtures.json").body);
    const p01 = exported.projects.find((p: { id: string }) => p.id === "prj_01");
    expect(p01).toMatchObject({ thumbnail_url: "https://img.example.org/cover.png", gallery_urls: images, tags: ["Rust", "human-computer-interaction"] });
    const p02 = exported.projects.find((p: { id: string }) => p.id === "prj_02");
    expect(Object.keys(p02).sort()).toEqual(["id", "repo_url", "submitted_at", "summary", "team", "title", "track"]);

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fields-")), "fixtures.json");
    fs.writeFileSync(file, JSON.stringify(exported));
    const fresh = openDatabase(":memory:");
    try {
      runMigrations(fresh, path.join(process.cwd(), "drizzle"));
      const { fixture, sha256 } = loadFixtureFile(file);
      importFixtures(fresh.db, fixture, { source: "fixtures.json", sha256, now: NOW });
      const moved = fresh.db.select().from(projects).where(eq(projects.id, "prj_01")).get()!;
      expect(moved).toMatchObject({ thumbnailUrl: "https://img.example.org/cover.png", galleryUrls: images, tags: ["Rust", "human-computer-interaction"] });
    } finally {
      fresh.sqlite.close();
    }

    // Known-bad: the importer refuses a script address in the same field.
    const bad = { ...exported, projects: exported.projects.map((p: { id: string }) => (p.id === "prj_01" ? { ...p, thumbnail_url: "javascript:alert(1)" } : p)) };
    expect(FixtureSchema.safeParse(bad).success).toBe(false);
  });
});
