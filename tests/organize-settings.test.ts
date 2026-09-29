import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { requireEvent } from "@/server/dal/events";
import { createEvent, MAX_CRITERIA, saveQuestions, saveRubric, saveTracks, updateEventDetails } from "@/server/dal/organize";
import { latestAudit } from "@/server/dal/audit-log";
import { acceptUnderReviewed, dismissDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import type { Actor } from "@/server/authz";

// The event settings an organizer edits: the rubric and the event's details. Both are
// organizer-only; criteria are fixed once judges have scored; and once the results are
// published the rubric and the event's dates are final, since they frame the scores.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function actor(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const organizer = () => actor("usr_organizer");
const judge = () => actor("jdg_01");

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

const auditOf = (action: string) => h.db.select().from(auditLog).where(eq(auditLog.action, action)).all();
const rubric = () =>
  h.sqlite.prepare("SELECT id, label, prompt, weight FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position").all() as {
    id: string;
    label: string;
    prompt: string;
    weight: number;
  }[];
const withWeight = (w: number) => rubric().map((c, i) => ({ ...c, weight: i === 0 ? w : c.weight }));
const weightChanges = () => requireEvent(h.db, "evt_01").settings.weightChanges ?? [];
const REASON = "Typo: functionality was meant to count double";

/** The details form as it would be sent back unchanged: times as "YYYY-MM-DDTHH:MM". */
function detailsAsSent(over: Record<string, unknown> = {}) {
  const e = requireEvent(h.db, "evt_01");
  const minute = (v: string | null) => (v ? new Date(v).toISOString().slice(0, 16) : "");
  return {
    name: e.name,
    description: e.description,
    submissionsOpenAt: minute(e.submissionsOpenAt),
    submissionsCloseAt: minute(e.submissionsCloseAt),
    judgingCloseAt: minute(e.judgingCloseAt),
    maxTeamSize: e.settings.maxTeamSize ?? 4,
    ...over,
  };
}

function publish() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(organizer(), "evt_01");
}

describe("the rubric", () => {
  it("takes up to 16 criteria on an event nobody has scored yet; a 17th is 422 on the field", () => {
    const fresh = createEvent({ ...organizer(), isAdmin: true }, { details: { name: "Detailed Rubric Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" }, tracks: [{ name: "Open" }], prizes: [] });
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `Criterion ${i + 1}`, prompt: `Question ${i + 1}?`, weight: 1 }));
    expect(MAX_CRITERIA).toBe(16);
    saveRubric(organizer(), fresh.id, rows(16));
    const saved = h.sqlite.prepare("SELECT count(*) AS n FROM rubric_criteria WHERE event_id = ?").get(fresh.id) as { n: number };
    expect(saved.n).toBe(16);
    let caught: unknown;
    try {
      saveRubric(organizer(), fresh.id, rows(17));
    } catch (err) {
      caught = err;
    }
    expect((caught as HttpError).status).toBe(422);
    expect(JSON.stringify((caught as HttpError).details)).toContain("criteria");
    expect((h.sqlite.prepare("SELECT count(*) AS n FROM rubric_criteria WHERE event_id = ?").get(fresh.id) as { n: number }).n).toBe(16);
  });

  it("known-bad: once judges have scored, a weight change without a reason is refused — 422, nothing changes", () => {
    expectHttpError(() => saveRubric(organizer(), "evt_01", withWeight(2)), 422, "invalid");
    expectHttpError(() => saveRubric(organizer(), "evt_01", { criteria: withWeight(2), reason: "  " }), 422, "invalid");
    expect(rubric()[0]!.weight).toBe(1);
    expect(auditOf("event.rubric")).toHaveLength(0);
    expect(auditOf("event.rubric_reweighted")).toHaveLength(0);
    expect(weightChanges()).toHaveLength(0);
  });

  it("once judges have scored, a weight changes with a reason: audited with it, kept on the event, listed by the published results", () => {
    expect(saveRubric(organizer(), "evt_01", { criteria: withWeight(2), reason: REASON }).reweighted).toBe(true);
    expect(rubric()[0]!.weight).toBe(2);
    const [row] = auditOf("event.rubric_reweighted");
    expect(row!.after).toMatchObject({ reason: REASON });
    expect(weightChanges()).toHaveLength(1);
    expect(weightChanges()[0]).toMatchObject({ reason: REASON, before: [{ weight: 1 }, { weight: 1 }, { weight: 1 }], after: [{ weight: 2 }, { weight: 1 }, { weight: 1 }] });
    publish();
    const results = getPublishedResults("evt_01");
    expect(results.published && results.weightChanges.map((c) => c.reason)).toEqual([REASON]);
  });

  it("after scoring, labels and prompts still change with no reason and nothing to disclose (positive control)", () => {
    const rows = rubric().map((c, i) => (i === 0 ? { ...c, label: "Does it work?", prompt: "Try the main path." } : c));
    saveRubric(organizer(), "evt_01", rows);
    expect(rubric()[0]).toMatchObject({ label: "Does it work?", prompt: "Try the main path.", weight: 1 });
    expect(auditOf("event.rubric")).toHaveLength(1);
    expect(weightChanges()).toHaveLength(0);
  });

  it("before any score, a weight changes with no reason and nothing to disclose (positive control)", () => {
    h.sqlite.prepare("DELETE FROM score_items").run();
    saveRubric(organizer(), "evt_01", withWeight(2));
    expect(rubric()[0]!.weight).toBe(2);
    expect(auditOf("event.rubric")).toHaveLength(1);
    expect(weightChanges()).toHaveLength(0);
  });

  it("known-bad: a judge cannot change it — 403, nothing changes", () => {
    expectHttpError(() => saveRubric(judge(), "evt_01", withWeight(5)), 403, "not_an_organizer");
    expect(rubric()[0]!.weight).toBe(1);
  });

  it("known-bad: once judges have scored, the set of criteria cannot change — 409 rubric_in_use", () => {
    expectHttpError(() => saveRubric(organizer(), "evt_01", rubric().slice(0, 2)), 409, "rubric_in_use");
    expect(rubric()).toHaveLength(3);
  });

  it("known-bad: once the results are published, not even a weight, reason or not — 409 results_published", () => {
    publish();
    expectHttpError(() => saveRubric(organizer(), "evt_01", withWeight(2)), 409, "results_published");
    expectHttpError(() => saveRubric(organizer(), "evt_01", { criteria: withWeight(2), reason: REASON }), 409, "results_published");
    expect(rubric()[0]!.weight).toBe(1);
    expect(weightChanges()).toHaveLength(0);
  });
});

describe("the event's details", () => {
  it("sending the form back unchanged changes nothing and writes no row, though the store holds '…:00Z' and the form sends '…:00'", () => {
    const stored = requireEvent(h.db, "evt_01").submissionsCloseAt;
    updateEventDetails(organizer(), "evt_01", detailsAsSent());
    expect(requireEvent(h.db, "evt_01").submissionsCloseAt).toBe(stored);
    expect(auditOf("event.update")).toHaveLength(0);
  });

  it("after publishing, the name can still change but the dates cannot — 409 results_published", () => {
    publish();
    updateEventDetails(organizer(), "evt_01", detailsAsSent({ name: "Sample Hack 2026, final" }));
    expect(requireEvent(h.db, "evt_01").name).toBe("Sample Hack 2026, final");

    expectHttpError(() => updateEventDetails(organizer(), "evt_01", detailsAsSent({ submissionsCloseAt: "2999-01-01T00:00" })), 409, "results_published");
    expect(requireEvent(h.db, "evt_01").submissionsCloseAt).toBe("2026-03-01T18:00:00Z");
  });

  it("before publishing, the dates can change (positive control)", () => {
    updateEventDetails(organizer(), "evt_01", detailsAsSent({ judgingCloseAt: "2026-04-01T18:00" }));
    expect(requireEvent(h.db, "evt_01").judgingCloseAt).toBe("2026-04-01T18:00:00.000Z");
  });

  it("known-bad: a date that does not exist is a 422 naming the field, not a crash, and changes nothing", () => {
    for (const bad of ["2026-13-45T10:00", "2026-02-30T10:00", "2026-04-01T24:00"]) {
      expectHttpError(() => updateEventDetails(organizer(), "evt_01", detailsAsSent({ judgingCloseAt: bad })), 422, "invalid");
    }
    expect(requireEvent(h.db, "evt_01").judgingCloseAt).toBeNull();
  });

  it("an API caller's full ISO time is taken as sent (positive control)", () => {
    updateEventDetails(organizer(), "evt_01", detailsAsSent({ judgingCloseAt: "2026-04-01T18:00:00.000Z" }));
    expect(requireEvent(h.db, "evt_01").judgingCloseAt).toBe("2026-04-01T18:00:00.000Z");
  });
});

describe("the tracks", () => {
  const tracks = () =>
    h.sqlite.prepare("SELECT id, name, position FROM tracks WHERE event_id = 'evt_01' ORDER BY position").all() as { id: string; name: string; position: number }[];
  const sent = () => tracks().map(({ id, name }) => ({ id, name }));
  const renamed = () => sent().map((t, i) => (i === 0 ? { ...t, name: "Dev tools" } : t));
  const swapped = () => {
    const rows = sent();
    [rows[0], rows[1]] = [rows[1]!, rows[0]!];
    return rows;
  };
  const publishedOrder = () => {
    const r = getPublishedResults("evt_01");
    return r.published ? r.tracks.map((t) => t.name) : [];
  };

  it("known-bad: once the results are published, a rename, a new order or a new track is refused — 409 results_published, nothing changes", () => {
    publish();
    const before = tracks();
    const order = publishedOrder();
    expect(order.length).toBeGreaterThan(1);
    expectHttpError(() => saveTracks(organizer(), "evt_01", renamed()), 409, "results_published");
    expectHttpError(() => saveTracks(organizer(), "evt_01", swapped()), 409, "results_published");
    expectHttpError(() => saveTracks(organizer(), "evt_01", [...sent(), { name: "Late track" }]), 409, "results_published");
    expect(tracks()).toEqual(before);
    expect(publishedOrder()).toEqual(order);
    expect(auditOf("event.tracks")).toHaveLength(0);
  });

  it("after publishing, sending the tracks back unchanged is fine and writes no row (positive control)", () => {
    publish();
    expect(saveTracks(organizer(), "evt_01", sent())).toEqual({ count: 8 });
    expect(auditOf("event.tracks")).toHaveLength(0);
  });

  it("before publishing, a rename and a new order are saved, and the row keeps each track's id, name and position (positive control)", () => {
    const [first, second] = tracks();
    saveTracks(organizer(), "evt_01", renamed());
    saveTracks(organizer(), "evt_01", swapped());
    expect(tracks().slice(0, 2)).toEqual([
      { id: second!.id, name: second!.name, position: 0 },
      { id: first!.id, name: "Dev tools", position: 1 },
    ]);
    const rows = auditOf("event.tracks");
    expect(rows).toHaveLength(2);
    expect((rows[0]!.before as unknown[])[0]).toEqual({ id: first!.id, name: first!.name, position: 0 });
    expect((rows[0]!.after as unknown[])[0]).toEqual({ id: first!.id, name: "Dev tools", position: 0 });
    expect((rows[1]!.after as unknown[]).slice(0, 2)).toEqual([
      { id: second!.id, name: second!.name, position: 0 },
      { id: first!.id, name: "Dev tools", position: 1 },
    ]);
    const words = latestAudit(h.db, "evt_01", 2, ["event.tracks"]).map((l) => l.parts.map((p) => p.text).join(""));
    expect(words[1]).toContain(`renamed “${first!.name}” to “Dev tools”`);
    expect(words[0]).toContain(`put them in the order “${second!.name}”, “Dev tools”`);
  });

  it("known-bad: a judge cannot change them — 403, nothing changes", () => {
    const before = tracks();
    expectHttpError(() => saveTracks(judge(), "evt_01", renamed()), 403, "not_an_organizer");
    expect(tracks()).toEqual(before);
  });
});

describe("a settings row sent without its name says so in words", () => {
  // the rows editor now sends a new row with only a tick or a weight changed (tests/row-typed.test.ts),
  // so the refusal it gets back is what the organizer reads under that row
  function detailsOf(call: () => unknown) {
    try {
      call();
    } catch (err) {
      expect((err as HttpError).status).toBe(422);
      return JSON.stringify((err as HttpError).details);
    }
    throw new Error("expected a 422");
  }
  it("a question ticked Required with no question: 422 naming what it needs", () => {
    expect(detailsOf(() => saveQuestions(organizer(), "evt_01", [{ label: "", help: "", type: "longtext", required: true }]))).toContain("a question needs at least 3 characters");
  });
  it("a criterion with only a weight: 422 naming what it needs", () => {
    const fresh = createEvent({ ...organizer(), isAdmin: true }, { details: { name: "Weights Only Hack", submissionsCloseAt: "2026-12-01T18:00:00Z" }, tracks: [{ name: "Open" }], prizes: [] });
    expect(detailsOf(() => saveRubric(organizer(), fresh.id, [{ label: "", prompt: "", weight: 2 }]))).toContain("a criterion needs a name of at least 2 characters");
  });
});
