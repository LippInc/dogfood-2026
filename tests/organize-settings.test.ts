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
import { saveRubric, updateEventDetails } from "@/server/dal/organize";
import { acceptUnderReviewed, dismissDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { publishResults } from "@/server/dal/results";
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
  it("known-bad: once judges have scored, a weight cannot change either — 409 rubric_in_use, nothing changes", () => {
    expectHttpError(() => saveRubric(organizer(), "evt_01", withWeight(2)), 409, "rubric_in_use");
    expect(rubric()[0]!.weight).toBe(1);
    expect(auditOf("event.rubric")).toHaveLength(0);
  });

  it("after scoring, labels and prompts still change, audited (positive control)", () => {
    const rows = rubric().map((c, i) => (i === 0 ? { ...c, label: "Does it work?", prompt: "Try the main path." } : c));
    saveRubric(organizer(), "evt_01", rows);
    expect(rubric()[0]).toMatchObject({ label: "Does it work?", prompt: "Try the main path.", weight: 1 });
    expect(auditOf("event.rubric")).toHaveLength(1);
  });

  it("before any score, a weight can change, audited (positive control)", () => {
    h.sqlite.prepare("DELETE FROM score_items").run();
    saveRubric(organizer(), "evt_01", withWeight(2));
    expect(rubric()[0]!.weight).toBe(2);
    expect(auditOf("event.rubric")).toHaveLength(1);
  });

  it("known-bad: a judge cannot change it — 403, nothing changes", () => {
    expectHttpError(() => saveRubric(judge(), "evt_01", withWeight(5)), 403, "not_an_organizer");
    expect(rubric()[0]!.weight).toBe(1);
  });

  it("known-bad: once judges have scored, the set of criteria cannot change — 409 rubric_in_use", () => {
    expectHttpError(() => saveRubric(organizer(), "evt_01", rubric().slice(0, 2)), 409, "rubric_in_use");
    expect(rubric()).toHaveLength(3);
  });

  it("known-bad: once the results are published, not even a weight — 409 results_published", () => {
    publish();
    expectHttpError(() => saveRubric(organizer(), "evt_01", withWeight(2)), 409, "results_published");
    expect(rubric()[0]!.weight).toBe(1);
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
