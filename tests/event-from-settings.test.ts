import { describe, expect, it } from "vitest";
import { createEvent, eventsToStartFrom } from "@/server/dal/organize";
import { verifyAuditChain } from "@/server/audit";
import { getDb } from "@/server/db/client";
import type { Actor } from "@/server/authz";
import { addUser, auditRows, count, expectHttpError, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// A club runs the same hackathon next month: the new event starts from the first one's settings (tracks, rubric,
// questions to teams, what teams fill in, team size, prizes, certificate places, voting rules), never its dates,
// people, teams, projects, reviews, votes, comments or invitations. Only someone who may manage the source event
// may copy it, the create and the copy commit together, and one audit row names the source.

withFixtureEvent();

const SOURCE = "evt_01";
/** The fixture's organizer, as a portal administrator (only administrators create events). */
const adminOrganizer = (): Actor => ({ ...organizer(), isAdmin: true });

const body = (extra: Record<string, unknown> = {}) => ({
  slug: "next-month",
  details: { name: "Next Month Hack", description: "Again", submissionsOpenAt: "", submissionsCloseAt: "2027-05-03T18:00", judgingCloseAt: "", maxTeamSize: "9" },
  sourceEventId: SOURCE,
  ...extra,
});

/** Give the source every kind of setting, and history that must stay behind. */
function dressSource() {
  const settings = JSON.parse(sqlGet<{ settings: string }>("SELECT settings FROM events WHERE id = ?", SOURCE)!.settings);
  sqlRun(
    "UPDATE events SET settings = ? WHERE id = ?",
    JSON.stringify({
      ...settings,
      maxTeamSize: 3,
      certificatePlaces: 5,
      judgingMode: "pairwise",
      judgeRanking: true,
      reviewsPerProject: 4,
      accent: "#aa3355",
      voting: { modes: ["account", "link"], votesPerVoter: 2, linkHash: "secret-hash", countLink: true, linkPerAddress: 5 },
      publishedRunId: "run_x",
      notDuplicates: ["a|b"],
      acceptedUnderReviewed: ["p1"],
      weightChanges: [{ at: "2026-09-01T00:00:00Z", reason: "r", before: [], after: [] }],
      voteRuleChanges: [{ at: "2026-09-01T00:00:00Z", reason: "r", before: { modes: ["account"], votesPerVoter: 1 }, after: { modes: ["account"], votesPerVoter: 2 } }],
    }),
    SOURCE,
  );
  sqlRun("INSERT INTO prizes (id, event_id, name, description, position) VALUES ('prz_s1', ?, 'Best hack', 'The best one', 0)", SOURCE);
  sqlRun("INSERT INTO custom_questions (id, event_id, label, help, type, required, position) VALUES ('q_s1', ?, 'What did you learn?', 'A line', 'text', 1, 0)", SOURCE);
  sqlRun("INSERT INTO project_fields (event_id, field, mode) VALUES (?, 'videoUrl', 'required'), (?, 'tags', 'hidden')", SOURCE, SOURCE);
  const first = sqlGet<{ id: string }>("SELECT id FROM rubric_criteria WHERE event_id = ? ORDER BY position LIMIT 1", SOURCE)!;
  sqlRun("UPDATE rubric_criteria SET label = 'Works for real', prompt = 'Does it run?', weight = 2.5 WHERE id = ?", first.id);
}

const rubricOf = (eventId: string) =>
  sqlAll("SELECT key, label, prompt, weight, scale_min, scale_max, anchors, position FROM rubric_criteria WHERE event_id = ? ORDER BY position", eventId);

describe("a new event from an existing one's settings", () => {
  it("copies every kind of setting", () => {
    dressSource();
    const made = createEvent(adminOrganizer(), body());
    expect(sqlAll("SELECT name, position FROM tracks WHERE event_id = ? ORDER BY position", made.id)).toEqual(
      sqlAll("SELECT name, position FROM tracks WHERE event_id = ? ORDER BY position", SOURCE),
    );
    expect(rubricOf(made.id)).toEqual(rubricOf(SOURCE));
    expect(rubricOf(made.id)[0]).toMatchObject({ label: "Works for real", prompt: "Does it run?", weight: 2.5 });
    expect(sqlAll("SELECT label, help, type, required FROM custom_questions WHERE event_id = ?", made.id)).toEqual([
      { label: "What did you learn?", help: "A line", type: "text", required: 1 },
    ]);
    expect(sqlAll("SELECT field, mode FROM project_fields WHERE event_id = ? ORDER BY field", made.id)).toEqual([
      { field: "tags", mode: "hidden" },
      { field: "videoUrl", mode: "required" },
    ]);
    expect(sqlAll("SELECT name, description FROM prizes WHERE event_id = ?", made.id)).toEqual([{ name: "Best hack", description: "The best one" }]);
    const settings = JSON.parse(sqlGet<{ settings: string }>("SELECT settings FROM events WHERE id = ?", made.id)!.settings);
    expect(settings).toEqual({
      maxTeamSize: 3,
      certificatePlaces: 5,
      judgingMode: "pairwise",
      judgeRanking: true,
      reviewsPerProject: 4,
      accent: "#aa3355",
      voting: { modes: ["account", "link"], votesPerVoter: 2, linkHash: null, countLink: true, linkPerAddress: 5 },
    });
  });

  it("takes the name and dates from the form, and leaves behind people, teams, projects, reviews, votes, comments and invitations", () => {
    dressSource();
    const made = createEvent(adminOrganizer(), body());
    const e = sqlGet<Record<string, unknown>>("SELECT name, description, submissions_close_at, voting_open_at, results_published_at FROM events WHERE id = ?", made.id)!;
    expect(e).toMatchObject({ name: "Next Month Hack", description: "Again", voting_open_at: null, results_published_at: null });
    expect(String(e.submissions_close_at)).toMatch(/^2027-05-03T18:00/);
    expect(sqlAll("SELECT user_id, role FROM user_roles WHERE event_id = ?", made.id)).toEqual([{ user_id: "usr_organizer", role: "organizer" }]);
    // the source has each of these, so a zero here is a real "left behind"
    for (const table of ["teams", "projects", "assignments", "judge_invites", "voters", "comments", "comparisons"]) {
      expect(count(`SELECT COUNT(*) AS n FROM ${table} WHERE event_id = ?`, made.id), table).toBe(0);
    }
    expect(count("SELECT COUNT(*) AS n FROM teams WHERE event_id = ?", SOURCE)).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM projects WHERE event_id = ?", SOURCE)).toBeGreaterThan(0);
    expect(count("SELECT COUNT(*) AS n FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE a.event_id = ?", made.id)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM judge_tracks jt JOIN tracks t ON t.id = jt.track_id WHERE t.event_id = ?", made.id)).toBe(0);
  });

  it("writes one event.create audit row that names the source, and the chain still verifies", () => {
    const before = auditRows().length;
    const made = createEvent(adminOrganizer(), body());
    const rows = auditRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "event.create", eventId: made.id, actorUserId: "usr_organizer" });
    expect((rows[0].after as { from: unknown }).from).toEqual({ id: SOURCE, slug: expect.any(String), name: expect.any(String) });
    expect(verifyAuditChain(getDb()).ok).toBe(true);
  });

  it("a source given by its web address works the same", () => {
    const slug = sqlGet<{ slug: string }>("SELECT slug FROM events WHERE id = ?", SOURCE)!.slug;
    const made = createEvent(adminOrganizer(), body({ sourceEventId: slug }));
    expect(count("SELECT COUNT(*) AS n FROM tracks WHERE event_id = ?", made.id)).toBe(count("SELECT COUNT(*) AS n FROM tracks WHERE event_id = ?", SOURCE));
  });
});

describe("who may start from an event", () => {
  it("refuses an administrator who does not organize the source (403), audits the refusal, and makes nothing", () => {
    const outsider: Actor = { ...addUser("usr_other_admin", "other-admin@example.org", "Other Admin"), isAdmin: true };
    const events = count("SELECT COUNT(*) AS n FROM events");
    const before = auditRows().length;
    expectHttpError(() => createEvent(outsider, body()), 403, "not_an_organizer");
    expect(count("SELECT COUNT(*) AS n FROM events")).toBe(events);
    const rows = auditRows().slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "authz.refused", eventId: SOURCE, actorUserId: "usr_other_admin" });
    expect((rows[0].after as { attempted: string }).attempted).toBe("event.manage");
    // positive control: the same administrator creates a blank event
    const blank = createEvent(outsider, { ...body({ sourceEventId: "" }), tracks: [{ name: "Tools" }] });
    expect(sqlGet("SELECT name FROM events WHERE id = ?", blank.id)).toEqual({ name: "Next Month Hack" });
  });

  it("the list shows only the events the person may manage", () => {
    const outsider: Actor = { ...addUser("usr_other_admin", "other-admin@example.org", "Other Admin"), isAdmin: true };
    expect(eventsToStartFrom(outsider)).toEqual([]);
    expect(eventsToStartFrom(adminOrganizer()).map((e) => e.id)).toEqual([SOURCE]);
    expect(eventsToStartFrom(null)).toEqual([]);
  });

  it("refuses an organizer of the source who is not an administrator: only administrators create events", () => {
    expectHttpError(() => createEvent(organizer(), body()), 403, "not_an_admin");
  });

  it("an unknown source is named under its own field", () => {
    expectHttpError(() => createEvent(adminOrganizer(), body({ sourceEventId: "evt_nope" })), 422, "invalid");
  });
});
