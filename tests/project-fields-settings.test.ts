import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { FixtureSchema, importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { assignments, auditLog, events, projects, userRoles, users } from "@/server/db/schema";
import { HttpError } from "@/server/errors";
import type { Actor } from "@/server/authz";
import { getGallery, getProjectFields } from "@/server/dal/events";
import { exportFile } from "@/server/dal/exports";
import { createEvent, getOrganizerEvent, saveProjectFields, saveTracks } from "@/server/dal/organize";
import { fieldModes } from "@/server/dal/project-fields";
import { setGallery } from "@/server/dal/project-image";
import { createProject, getMyWork, getPublicProject, updateProject } from "@/server/dal/projects";
import { getNormalization } from "@/server/dal/results";
import { getJudgeConsole } from "@/server/dal/reviews";
import { getSubmissions } from "@/server/dal/submissions";
import { getBallot } from "@/server/dal/voting";
import { getPairwiseState, setJudgingMode } from "@/server/dal/pairwise";
import { createTeam } from "@/server/dal/teams";
import { DEFAULT_FIELD_MODES } from "@/lib/project-fields";

// What a team fills in is the organizer's choice, field by field: required, optional or hidden.
// An event nobody changed behaves exactly as the form always did; a required field is refused on
// submit; a title nobody gives is the team's name; a hidden field is ignored when sent, kept when
// stored, and empty wherever the project is shown to anyone but its team; every project keeps a
// track; the choice travels through the fixtures.json export and import; only the event's
// organizers change it (401 without a session, 403 for anyone else).

const NOW = "2026-09-28T20:00:00.000Z";
const OPEN = "2099-01-01T00:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  // submissions open again, so teams can save
  h.db.update(events).set({ submissionsCloseAt: OPEN }).where(eq(events.id, "evt_01")).run();
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

/** The person as a session would carry them now: roles read from the database. */
function actor(userId: string): Actor {
  const u = h.db.select().from(users).where(eq(users.id, userId)).get()!;
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: u.isAdmin, roles, sessionKind: "login" };
}
const organizer = () => actor("usr_organizer");

let people = 0;
/** A new account on a new team in the event; returns the member and the team's name. */
function newTeam(event: string, teamName: string): { member: () => Actor; teamName: string } {
  const id = `usr_t${++people}`;
  h.db.insert(users).values({ id, email: `${id}@example.org`, name: `Person ${people}`, passwordHash: null, isAdmin: false, createdAt: NOW }).run();
  createTeam(actor(id), event, { name: teamName });
  return { member: () => actor(id), teamName };
}

/** A new event with one track, run by the demo organizer: everyone builds the same thing. */
function sameBriefEvent(): { id: string; slug: string; trackId: string } {
  const { id, slug } = createEvent(organizer(), {
    details: { name: "Same Brief Jam", submissionsCloseAt: "2099-01-01T00:00" },
    tracks: [{ name: "The brief" }],
  });
  const trackId = (h.sqlite.prepare("SELECT id FROM tracks WHERE event_id = ?").get(id) as { id: string }).id;
  return { id, slug, trackId };
}

function refusal(call: () => unknown): { status: number; code: string; fields: Record<string, string[]> } | null {
  try {
    call();
    return null;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, code: err.code, fields: (err.details as Record<string, string[]>) ?? {} };
  }
}

const row = (id: string) => h.db.select().from(projects).where(eq(projects.id, id)).get()!;

describe("an event nobody changed asks what the form always asked", () => {
  it("reads the defaults: title, summary and track required, the rest optional", () => {
    expect(fieldModes(h.db, "evt_01")).toEqual(DEFAULT_FIELD_MODES);
    expect(getProjectFields("sample-hack-2026").fields).toEqual(DEFAULT_FIELD_MODES);
    const team = newTeam("evt_01", "Defaults");
    expect(getMyWork(team.member(), "evt_01").fields).toEqual(DEFAULT_FIELD_MODES);
  });

  it("refuses a draft without a title or a track, and a submission without a summary; the rest may stay empty", () => {
    const team = newTeam("evt_01", "Defaults");
    expect(refusal(() => createProject(team.member(), "evt_01", { title: "", trackId: "trk_01", status: "draft" }))).toMatchObject({
      status: 422,
      fields: { title: ["a title is required"] },
    });
    expect(refusal(() => createProject(team.member(), "evt_01", { title: "No track", status: "draft" }))?.fields).toHaveProperty("trackId");
    expect(refusal(() => createProject(team.member(), "evt_01", { title: "Plain", trackId: "trk_01" }))).toMatchObject({
      status: 422,
      fields: { summary: ["a one-line summary is required to submit"] },
    });
    const made = createProject(team.member(), "evt_01", { title: "Plain", summary: "One line", trackId: "trk_01" });
    expect(row(made.id)).toMatchObject({ status: "submitted", title: "Plain", repoUrl: null, description: "" });
  });
});

describe("a field the organizer makes required", () => {
  it("refuses a submission without it, naming the field; a draft may wait; filled, it is accepted", () => {
    saveProjectFields(organizer(), "evt_01", { repoUrl: "required" });
    const team = newTeam("evt_01", "Needs a repo");
    const body = { title: "Repo please", summary: "One line", trackId: "trk_01" };
    expect(refusal(() => createProject(team.member(), "evt_01", body))).toMatchObject({
      status: 422,
      fields: { repoUrl: ["a repository link is required to submit"] },
    });
    const draft = createProject(team.member(), "evt_01", { ...body, status: "draft" });
    expect(row(draft.id).status).toBe("draft");
    updateProject(team.member(), draft.id, { ...body, repoUrl: "https://example.org/code" });
    expect(row(draft.id)).toMatchObject({ status: "submitted", repoUrl: "https://example.org/code" });
    // a submitted project saved again without it is refused too, as a required question is
    expect(refusal(() => updateProject(team.member(), draft.id, body))?.fields).toHaveProperty("repoUrl");
  });

  it("can make the summary optional: a submission without one is accepted", () => {
    saveProjectFields(organizer(), "evt_01", { summary: "optional" });
    const team = newTeam("evt_01", "No summary");
    const made = createProject(team.member(), "evt_01", { title: "Quiet", trackId: "trk_01" });
    expect(row(made.id)).toMatchObject({ status: "submitted", summary: "" });
  });
});

describe("a title the team does not give", () => {
  it("optional and left empty: the project is called by its team's name, on every save that leaves it empty", () => {
    saveProjectFields(organizer(), "evt_01", { title: "optional" });
    const team = newTeam("evt_01", "Night Owls");
    const made = createProject(team.member(), "evt_01", { title: "", summary: "One line", trackId: "trk_01" });
    expect(row(made.id).title).toBe("Night Owls");
    updateProject(team.member(), made.id, { title: "Owl Radar", summary: "One line", trackId: "trk_01" });
    expect(row(made.id).title).toBe("Owl Radar");
    updateProject(team.member(), made.id, { summary: "One line", trackId: "trk_01" });
    expect(row(made.id).title).toBe("Night Owls");
    const card = getGallery("evt_01").projects.find((p) => p.id === made.id)!;
    expect(card.title).toBe("Night Owls");
  });

  it("hidden: never asked, a title sent anyway is ignored, and the team's name stays the project's name", () => {
    saveProjectFields(organizer(), "evt_01", { title: "hidden" });
    const team = newTeam("evt_01", "Larks");
    const made = createProject(team.member(), "evt_01", { title: "Sent anyway", summary: "One line", trackId: "trk_01" });
    expect(row(made.id).title).toBe("Larks");
    updateProject(team.member(), made.id, { title: "Sent again", summary: "One line", trackId: "trk_01" });
    expect(row(made.id).title).toBe("Larks");
  });

  it("hidden on a project that already has one: the team's name wherever it is shown, the typed title kept and back with the field", () => {
    // the fixture's first project has a typed title of its own, is submitted, scored and judged
    const typed = row("prj_01").title;
    const teamName = (h.sqlite.prepare("SELECT name FROM teams WHERE id = 'tm_01'").get() as { name: string }).name;
    expect(typed).not.toBe(teamName);
    const judgeId = h.db.select({ j: assignments.judgeUserId }).from(assignments).where(eq(assignments.projectId, "prj_01")).get()!.j;
    const captain = actor((h.sqlite.prepare("SELECT user_id AS id FROM team_members WHERE team_id = 'tm_01' AND role = 'captain'").get() as { id: string }).id);
    const names = () => ({
      page: getPublicProject("evt_01", "prj_01").project.title,
      gallery: getGallery("evt_01").projects.find((p) => p.id === "prj_01")?.title,
      judge: getJudgeConsole(actor(judgeId), "evt_01").items.find((i) => i.project.id === "prj_01")?.project.title,
      results: getNormalization(organizer(), "evt_01").normalization.projects.find((p) => p.id === "prj_01")?.title,
      submissions: getSubmissions(organizer(), "evt_01").rows.find((p) => p.id === "prj_01")?.title,
      team: getMyWork(captain, "evt_01").project?.title,
      csv: csvRow()?.at(-1),
    });
    // projects.csv: the stored title in `title` (the organizer's export stays complete), the shown one in `shown_title`
    const csvLines = () => exportFile(organizer(), "evt_01", "projects.csv").body.split(/\r?\n/);
    const csvRow = () => csvLines().find((l) => l.startsWith("prj_01,"))?.split(",");
    expect(csvLines()[0]!.split(",").at(-1)).toBe("shown_title");
    const everywhere = (name: string) => ({ page: name, gallery: name, judge: name, results: name, submissions: name, team: name, csv: name });
    // a second, differently named entry from the same team: not a copy while the titles differ
    const cols = (h.sqlite.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name);
    const copy = cols.map((c) => (c === "id" ? "'prj_01b'" : c === "title" ? "'Another Thing'" : c)).join(", ");
    h.sqlite.prepare(`INSERT INTO projects (${cols.join(", ")}) SELECT ${copy} FROM projects WHERE id = 'prj_01'`).run();
    const duplicates = () => getNormalization(organizer(), "evt_01").decisions.filter((d) => d.kind === "duplicate").map((d) => d.key);
    const found = duplicates();
    // the control: while the title is asked, every reader shows the typed one
    expect(names()).toEqual(everywhere(typed));

    saveProjectFields(organizer(), "evt_01", { title: "hidden" });
    expect(names()).toEqual(everywhere(teamName));
    expect(row("prj_01").title).toBe(typed);
    expect(csvRow()?.[1]).toBe(typed);
    // scores.csv the same: the stored title in `project_title`, the shown one in `shown_title` at the end
    const scoreLines = exportFile(organizer(), "evt_01", "scores.csv").body.split(/\r?\n/);
    const scoreHead = scoreLines[0]!.split(",");
    expect(scoreHead.at(-1)).toBe("shown_title");
    const scoreRow = scoreLines.find((l) => l.startsWith("prj_01,"))?.split(",");
    expect(scoreRow?.[scoreHead.indexOf("project_title")]).toBe(typed);
    expect(scoreRow?.at(-1)).toBe(teamName);
    // copies of one entry are still found by what the team typed, not by the shared team name
    expect(duplicates()).toEqual(found);
    // the event's own export keeps what the team typed, so an import loses nothing
    const exported = JSON.parse(exportFile(organizer(), "evt_01", "fixtures.json").body) as { projects: { id: string; title: string }[] };
    expect(exported.projects.find((p) => p.id === "prj_01")?.title).toBe(typed);

    saveProjectFields(organizer(), "evt_01", { title: "required" });
    expect(names()).toEqual(everywhere(typed));
  });
});

describe("a hidden field", () => {
  const filled = {
    title: "Glass Signal",
    summary: "One line of what it does.",
    description: "Long words.",
    trackId: "trk_04",
    repoUrl: "https://example.org/repo/01",
    videoUrl: "https://example.org/video",
    liveUrl: "https://example.org/live",
    thumbnailUrl: "https://img.example.org/cover.png",
    galleryUrls: ["https://img.example.org/1.png"],
    tags: ["rust"],
  };
  const hideAll = { summary: "hidden", description: "hidden", repoUrl: "hidden", videoUrl: "hidden", liveUrl: "hidden", thumbnailUrl: "hidden", galleryUrls: "hidden", tags: "hidden" } as const;
  // a fixture team member edits the fixture's first project, which judges have scored
  const member = () => actor((h.sqlite.prepare("SELECT user_id AS id FROM team_members WHERE team_id = 'tm_01' AND role = 'captain'").get() as { id: string }).id);

  it("is empty on the public page, the gallery card and the judge's console, and shows again when turned back on", () => {
    updateProject(member(), "prj_01", filled);
    setGallery(member(), "prj_01", { galleryUrls: filled.galleryUrls }); // a saved project's gallery changes only here
    const judgeId = h.db.select({ j: assignments.judgeUserId }).from(assignments).where(eq(assignments.projectId, "prj_01")).get()!.j;
    const consoleItem = () => getJudgeConsole(actor(judgeId), "evt_01").items.find((i) => i.project.id === "prj_01")!;
    // shown while asked (the control: these values reach every reader)
    expect(getPublicProject("evt_01", "prj_01").project).toMatchObject({ summary: filled.summary, repoUrl: filled.repoUrl, tags: ["rust"] });
    expect(consoleItem().project.repoUrl).toBe(filled.repoUrl);
    // the community ballot and a pairwise judge's cards (the same judge, after a switch to pairwise) show them too
    const ballotItem = () => getBallot(null, "evt_01", null).projects.find((p) => p.id === "prj_01")!;
    expect(ballotItem().summary).toBe(filled.summary);
    setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "compare two at a time" });
    const card = () => getPairwiseState(actor(judgeId), "evt_01").tracks.flatMap((t) => t.projects).find((p) => p.id === "prj_01")!;
    expect(card()).toMatchObject({ summary: filled.summary, repoUrl: filled.repoUrl, tags: ["rust"] });

    saveProjectFields(organizer(), "evt_01", hideAll);
    expect(ballotItem().summary).toBe("");
    expect(card()).toMatchObject({ summary: "", description: "", repoUrl: null, videoUrl: null, liveUrl: null, thumbnailUrl: null, tags: [] });
    const shown = getPublicProject("evt_01", "prj_01");
    expect(shown.fields.repoUrl).toBe("hidden");
    expect(shown.project).toMatchObject({
      title: "Glass Signal",
      summary: "",
      description: "",
      repoUrl: null,
      videoUrl: null,
      liveUrl: null,
      thumbnailUrl: null,
      galleryUrls: [],
      tags: [],
    });
    expect(getGallery("evt_01").projects.find((p) => p.id === "prj_01")).toMatchObject({ summary: "", thumbnailUrl: null, tags: [] });
    const judged = consoleItem();
    expect(judged.project).toMatchObject({ summary: "", description: "", repoUrl: null, videoUrl: null, liveUrl: null, galleryUrls: [], tags: [] });
    expect(getJudgeConsole(actor(judgeId), "evt_01").fields.repoUrl).toBe("hidden");

    // kept in the store, and a save without the hidden fields (or with others sent for them) leaves them as they are
    updateProject(member(), "prj_01", { title: "Glass Signal", trackId: "trk_04", repoUrl: "https://example.org/elsewhere", tags: ["go"] });
    expect(row("prj_01")).toMatchObject({ summary: filled.summary, repoUrl: filled.repoUrl, tags: ["rust"], galleryUrls: filled.galleryUrls });

    saveProjectFields(organizer(), "evt_01", Object.fromEntries(Object.keys(hideAll).map((f) => [f, "optional"])));
    expect(getPublicProject("evt_01", "prj_01").project).toMatchObject({ summary: filled.summary, repoUrl: filled.repoUrl, tags: ["rust"] });
  });

  it("is still in the organizer's CSV export", () => {
    updateProject(member(), "prj_01", filled);
    saveProjectFields(organizer(), "evt_01", hideAll);
    const csv = exportFile(organizer(), "evt_01", "projects.csv").body;
    expect(csv).toContain(filled.repoUrl);
    expect(csv).toContain(filled.summary);
  });
});

describe("every project keeps a track", () => {
  it("with one track, a hidden track is the team's without asking", () => {
    const jam = sameBriefEvent();
    saveProjectFields(organizer(), jam.slug, { trackId: "hidden" });
    const team = newTeam(jam.slug, "Solo");
    expect(getMyWork(team.member(), jam.slug).fields.trackId).toBe("hidden");
    const made = createProject(team.member(), jam.slug, { title: "Brief", summary: "One line" });
    expect(row(made.id).trackId).toBe(jam.trackId);
  });

  it("is never optional, and hidden only while the event has one track", () => {
    expect(refusal(() => saveProjectFields(organizer(), "evt_01", { trackId: "hidden" }))).toMatchObject({ status: 422, fields: { trackId: [expect.stringContaining("one track")] } });
    expect(refusal(() => saveProjectFields(organizer(), "evt_01", { trackId: "optional" }))).toMatchObject({ status: 422, fields: { trackId: [expect.stringContaining("cannot be optional")] } });
    expect(fieldModes(h.db, "evt_01").trackId).toBe("required");
  });

  it("is asked again once a second track is added, so no project goes without one", () => {
    const jam = sameBriefEvent();
    saveProjectFields(organizer(), jam.slug, { trackId: "hidden" });
    saveTracks(organizer(), jam.slug, [{ id: jam.trackId, name: "The brief" }, { name: "Wildcard" }]);
    expect(fieldModes(h.db, jam.id).trackId).toBe("required");
    const team = newTeam(jam.slug, "Late");
    expect(refusal(() => createProject(team.member(), jam.slug, { title: "No track", summary: "One line" }))?.fields).toHaveProperty("trackId");
  });

  it("the organizer's hidden track comes back with one track again, though other fields were saved while there were two", () => {
    const jam = sameBriefEvent();
    saveProjectFields(organizer(), jam.slug, { trackId: "hidden" });
    saveTracks(organizer(), jam.slug, [{ id: jam.trackId, name: "The brief" }, { name: "Wildcard" }]);
    // the settings form sends every field as it shows it, the track as required while there are two; then one field alone
    saveProjectFields(organizer(), jam.slug, { ...fieldModes(h.db, jam.id), summary: "optional" });
    saveProjectFields(organizer(), jam.slug, { tags: "hidden" });
    expect(fieldModes(h.db, jam.id)).toMatchObject({ trackId: "required", summary: "optional", tags: "hidden" });
    saveTracks(organizer(), jam.slug, [{ id: jam.trackId, name: "The brief" }]);
    expect(fieldModes(h.db, jam.id)).toMatchObject({ trackId: "hidden", summary: "optional", tags: "hidden" });
  });

  it("the database itself refuses a track that is optional, a field it does not know and a mode it does not know", () => {
    const insert = (field: string, mode: string) => () =>
      h.sqlite.prepare("INSERT INTO project_fields (event_id, field, mode) VALUES ('evt_01', ?, ?)").run(field, mode);
    expect(insert("trackId", "optional")).toThrow(/CHECK constraint failed: project_fields_track_kept/);
    expect(insert("teamSize", "required")).toThrow(/CHECK constraint failed: project_fields_field/);
    expect(insert("title", "maybe")).toThrow(/CHECK constraint failed: project_fields_mode/);
    expect(insert("title", "hidden")).not.toThrow();
  });
});

describe("the choice travels with the event", () => {
  const SAME_BRIEF = { title: "hidden", summary: "hidden", trackId: "hidden", description: "hidden", repoUrl: "required", videoUrl: "hidden", liveUrl: "hidden", thumbnailUrl: "hidden", galleryUrls: "hidden", tags: "hidden" } as const;

  function freshImport(file: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fields-"));
    const at = path.join(dir, "fixtures.json");
    fs.writeFileSync(at, JSON.stringify(file));
    const fresh = openDatabase(":memory:");
    runMigrations(fresh, path.join(process.cwd(), "drizzle"));
    const { fixture, sha256 } = loadFixtureFile(at);
    const first = importFixtures(fresh.db, fixture, { source: "fixtures.json", sha256, now: NOW });
    return { fresh, first, again: () => importFixtures(fresh.db, fixture, { source: "fixtures.json", sha256, now: NOW }) };
  }

  it("fixtures.json and event.json carry it; an import restores it, and importing again changes nothing", () => {
    const jam = sameBriefEvent();
    saveProjectFields(organizer(), jam.slug, SAME_BRIEF);
    const team = newTeam(jam.slug, "Solo");
    createProject(team.member(), jam.slug, { repoUrl: "https://example.org/solo" });
    const exported = JSON.parse(exportFile(organizer(), jam.slug, "fixtures.json").body);
    expect(exported.project_fields).toEqual(SAME_BRIEF);
    expect(JSON.parse(exportFile(organizer(), jam.slug, "event.json").body).projectFields).toEqual(SAME_BRIEF);
    expect(FixtureSchema.safeParse(exported).success).toBe(true);

    const { fresh, first, again } = freshImport(exported);
    try {
      expect(first.inserted.projectFields).toBe(10);
      expect(fieldModes(fresh.db, jam.id)).toEqual(SAME_BRIEF);
      const second = again();
      expect(second.inserted.projectFields).toBe(0);
      expect(second.existing.projectFields).toBe(10);
      expect(fieldModes(fresh.db, jam.id)).toEqual(SAME_BRIEF);
    } finally {
      fresh.sqlite.close();
    }
  });

  it("an older export without it imports with the defaults, and the fixture event exports without it", () => {
    expect(JSON.parse(exportFile(organizer(), "evt_01", "fixtures.json").body)).not.toHaveProperty("project_fields");
    const jam = sameBriefEvent();
    saveProjectFields(organizer(), jam.slug, SAME_BRIEF);
    const { project_fields: _dropped, ...older } = JSON.parse(exportFile(organizer(), jam.slug, "fixtures.json").body);
    const { fresh, first } = freshImport(older);
    try {
      expect(first.inserted.projectFields).toBe(0);
      expect(fieldModes(fresh.db, jam.id)).toEqual(DEFAULT_FIELD_MODES);
    } finally {
      fresh.sqlite.close();
    }
  });

  it("a file whose hidden track could not stay a track is imported without that choice, and says so", () => {
    const jam = sameBriefEvent();
    saveProjectFields(organizer(), jam.slug, SAME_BRIEF);
    const file = JSON.parse(exportFile(organizer(), jam.slug, "fixtures.json").body);
    file.tracks.push({ id: "trk_second", name: "Second" });
    const { fresh, first } = freshImport(file);
    try {
      expect(first.skipped).toContainEqual(expect.objectContaining({ kind: "projectField", id: "trackId" }));
      expect(fieldModes(fresh.db, jam.id)).toMatchObject({ trackId: "required", repoUrl: "required", title: "hidden" });
    } finally {
      fresh.sqlite.close();
    }
  });
});

describe("only the event's organizers change it", () => {
  const judgeOf = () => actor(h.db.select({ j: assignments.judgeUserId }).from(assignments).where(eq(assignments.eventId, "evt_01")).get()!.j);
  const lastAudit = () => h.db.select().from(auditLog).orderBy(desc(auditLog.id)).get()!;

  it("no session: 401, and nothing changes", () => {
    expect(refusal(() => saveProjectFields(null, "evt_01", { repoUrl: "required" }))).toMatchObject({ status: 401, code: "unauthenticated" });
    expect(fieldModes(h.db, "evt_01").repoUrl).toBe("optional");
  });

  it("a participant, a judge or an administrator who does not organize the event: 403, each refusal audited, nothing changes", () => {
    const participant = newTeam("evt_01", "Curious").member();
    h.db.insert(users).values({ id: "usr_admin2", email: "admin2@example.org", name: "Another admin", passwordHash: null, isAdmin: true, createdAt: NOW }).run();
    for (const who of [participant, judgeOf(), actor("usr_admin2")]) {
      expect(refusal(() => saveProjectFields(who, "evt_01", { repoUrl: "required" }))).toMatchObject({ status: 403, code: "not_an_organizer" });
      expect(lastAudit()).toMatchObject({ action: "authz.refused", actorUserId: who.userId, eventId: "evt_01" });
    }
    expect(fieldModes(h.db, "evt_01").repoUrl).toBe("optional");
    // reading them stays open to anyone (it is the shape of the form), the organizer's settings view is not
    expect(getProjectFields("evt_01").fields.repoUrl).toBe("optional");
    expect(refusal(() => getOrganizerEvent(participant, "evt_01"))?.status).toBe(403);
  });

  it("the organizer (positive control): saved, with one audit row naming exactly what changed; saving it again writes none", () => {
    const result = saveProjectFields(organizer(), "evt_01", { repoUrl: "required", tags: "hidden" });
    expect(result.changed).toBe(true);
    expect(fieldModes(h.db, "evt_01")).toMatchObject({ repoUrl: "required", tags: "hidden", title: "required" });
    expect(getOrganizerEvent(organizer(), "evt_01").fields).toMatchObject({ repoUrl: "required", tags: "hidden" });
    const audit = lastAudit();
    expect(audit).toMatchObject({ action: "event.project_fields", actorUserId: "usr_organizer", eventId: "evt_01" });
    expect(audit.before).toEqual({ repoUrl: "optional", tags: "optional" });
    expect(audit.after).toEqual({ repoUrl: "required", tags: "hidden" });
    const rows = () => h.db.select().from(auditLog).where(and(eq(auditLog.action, "event.project_fields"), eq(auditLog.eventId, "evt_01"))).all().length;
    const again = saveProjectFields(organizer(), "evt_01", { repoUrl: "required" });
    expect(again.changed).toBe(false);
    expect(rows()).toBe(1);
  });

  it("a body that is not a list of fields and modes is 422, before anything is written", () => {
    expect(refusal(() => saveProjectFields(organizer(), "evt_01", { teamSize: "required" }))?.status).toBe(422);
    expect(refusal(() => saveProjectFields(organizer(), "evt_01", { title: "sometimes" }))?.fields).toHaveProperty("title");
    expect(refusal(() => saveProjectFields(organizer(), "evt_01", null))?.status).toBe(422);
    expect(fieldModes(h.db, "evt_01")).toEqual(DEFAULT_FIELD_MODES);
  });
});
