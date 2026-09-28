import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");
const { exportFile } = await import("@/server/dal/exports");

// fixtures.json is the file that moves an event between portals. It carried no rubric, so a move reset every weight
// to 1 and every label to its capitalised key, and it dropped each project's description, video and live links and
// the teams' answers to the event's own questions. The export now adds them (only when there is something to add,
// so the organizers' fixture data still exports as it came) and the importer takes them.

const NOW = "2026-09-28T00:00:00.000Z";
let ha: Handle;
let hb: Handle | null = null;

function actorIn(h: Handle, userId: string, name: string, email: string): Actor {
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId, name, email, isAdmin: true, roles, sessionKind: "login" };
}
const organizerA = () => actorIn(ha, "usr_organizer", "Demo Organizer", "organizer@example.org");

beforeEach(() => {
  ha = openDatabase(":memory:");
  runMigrations(ha, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(ha.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(ha.db, "evt_01", NOW);
  setHandleForTests(ha);
});
afterEach(() => {
  setHandleForTests(null);
  ha.sqlite.close();
  hb?.sqlite.close();
  hb = null;
});

function importIntoB(file: unknown) {
  hb = openDatabase(":memory:");
  runMigrations(hb, path.join(process.cwd(), "drizzle"));
  hb.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_b', 'b@example.org', 'Admin B', NULL, 1, ?)").run(NOW);
  setHandleForTests(hb);
  const report = importEventFile(actorIn(hb, "usr_b", "Admin B", "b@example.org"), file);
  setHandleForTests(ha);
  return report;
}

describe("fixtures.json moves an event between portals", () => {
  it("positive control: the organizers' fixture data exports with no key the fixture file does not have", () => {
    const exported = JSON.parse(exportFile(organizerA(), "evt_01", "fixtures.json").body);
    const original = JSON.parse(fs.readFileSync(path.join(process.cwd(), "fixtures.json"), "utf8"));
    expect(Object.keys(exported).sort()).toEqual(Object.keys(original).sort());
    expect(Object.keys(exported.event).sort()).toEqual(Object.keys(original.event).sort());
  });

  it("known-bad: the rubric's weights, labels and prompts, the questions and answers, and each project's description and links arrive", () => {
    const a = ha.sqlite;
    a.prepare("UPDATE rubric_criteria SET weight = 2.5, label = 'Real-world impact', prompt = 'Who is helped?' WHERE event_id = 'evt_01' AND key = 'functionality'").run();
    a.prepare("UPDATE events SET description = 'A weekend of building.' WHERE id = 'evt_01'").run();
    const project = (a.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' ORDER BY id LIMIT 1").get() as { id: string }).id;
    a.prepare("UPDATE projects SET description = 'How it works, at length.', video_url = 'https://video.example.org/v', live_url = 'https://live.example.org' WHERE id = ?").run(project);
    a.prepare("INSERT INTO custom_questions (id, event_id, label, help, type, required, position) VALUES ('q_stack', 'evt_01', 'What did you build it with?', '', 'text', 1, 0)").run();
    a.prepare("INSERT INTO custom_answers (project_id, question_id, value) VALUES (?, 'q_stack', 'Rust and hope')").run(project);

    const file = JSON.parse(exportFile(organizerA(), "evt_01", "fixtures.json").body);
    const report = importIntoB(file);
    expect(report.inserted.customQuestions).toBe(1);
    expect(report.inserted.customAnswers).toBe(1);

    const b = hb!.sqlite;
    const changed = b.prepare("SELECT label, prompt, weight FROM rubric_criteria WHERE event_id = 'evt_01' AND key = 'functionality'").get();
    expect(changed).toEqual({ label: "Real-world impact", prompt: "Who is helped?", weight: 2.5 });
    const criteriaA = a.prepare("SELECT key, label, prompt, weight, anchors, position FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position").all();
    expect(b.prepare("SELECT key, label, prompt, weight, anchors, position FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position").all()).toEqual(criteriaA);
    expect(b.prepare("SELECT description FROM events WHERE id = 'evt_01'").get()).toEqual({ description: "A weekend of building." });
    expect(b.prepare("SELECT description, video_url AS v, live_url AS l FROM projects WHERE id = ?").get(project)).toEqual({
      description: "How it works, at length.",
      v: "https://video.example.org/v",
      l: "https://live.example.org",
    });
    expect(b.prepare("SELECT label, type, required FROM custom_questions WHERE id = 'q_stack'").get()).toEqual({ label: "What did you build it with?", type: "text", required: 1 });
    expect(b.prepare("SELECT value FROM custom_answers WHERE project_id = ? AND question_id = 'q_stack'").get(project)).toEqual({ value: "Rust and hope" });
  });

  it("a rubric criterion no review uses yet moves too, and a question id another event holds is renamed", () => {
    ha.sqlite.prepare("INSERT INTO rubric_criteria (id, event_id, key, label, prompt, weight, scale_min, scale_max, anchors, position) VALUES ('crit_evt_01_demo', 'evt_01', 'demo', 'Demo', '', 1, 1, 5, '{}', 9)").run();
    ha.sqlite.prepare("INSERT INTO custom_questions (id, event_id, label, help, type, required, position) VALUES ('q_1', 'evt_01', 'Anything else?', '', 'longtext', 0, 0)").run();
    const file = JSON.parse(exportFile(organizerA(), "evt_01", "fixtures.json").body);
    expect(file.rubric.map((c: { key: string }) => c.key)).toContain("demo");

    hb = openDatabase(":memory:");
    runMigrations(hb, path.join(process.cwd(), "drizzle"));
    // portal B already has an event whose question is called q_1
    hb.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_b', 'b@example.org', 'Admin B', NULL, 1, ?)").run(NOW);
    hb.sqlite.prepare("INSERT INTO events (id, slug, name, submissions_close_at, created_at) VALUES ('evt_other', 'other', 'Other', ?, ?)").run(NOW, NOW);
    hb.sqlite.prepare("INSERT INTO custom_questions (id, event_id, label, help, type, required, position) VALUES ('q_1', 'evt_other', 'Theirs', '', 'text', 0, 0)").run();
    setHandleForTests(hb);
    const report = importEventFile(actorIn(hb, "usr_b", "Admin B", "b@example.org"), file);
    setHandleForTests(ha);
    expect(report.renamed).toContainEqual({ kind: "question", from: "q_1", to: "q_1.evt_01" });
    expect(hb.sqlite.prepare("SELECT label FROM custom_questions WHERE id = 'q_1.evt_01'").get()).toEqual({ label: "Anything else?" });
    expect(hb.sqlite.prepare("SELECT count(*) AS n FROM rubric_criteria WHERE event_id = 'evt_01' AND key = 'demo'").get()).toEqual({ n: 1 });
  });
});
