import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { userRoles } from "@/server/db/schema";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import type { Actor } from "@/server/authz";

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { importEventFile } = await import("@/server/dal/imports");
const { exportFile } = await import("@/server/dal/exports");
const { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } = await import("@/server/dal/decisions");
const { getPublishedResults, publishResults } = await import("@/server/dal/results");
const { closeFinals, openFinals, saveFinalsScore, setFinalsPanel, addFinalist } = await import("@/server/dal/finals");

// The finals move with the event: an event that held finals, exported as fixtures.json after publishing and imported
// on another portal as a new event, exports the same file there and publishes the same places, finals order included.
// Into an event that is here, a file bringing a finals round the event does not hold is refused (409 new_event_only).

const NOW = "2026-09-29T08:00:00.000Z";
let ha: Handle;
let hb: Handle | null = null;

function actorIn(h: Handle, userId: string, isAdmin = false): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin, roles, sessionKind: "login" };
}
const organizerA = () => actorIn(ha, "usr_organizer", true);

function freshPortal(): Handle {
  const h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  h.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_b', 'b@example.org', 'Admin B', NULL, 1, ?)").run(NOW);
  return h;
}
function inB<T>(fn: () => T): T {
  hb ??= freshPortal();
  setHandleForTests(hb);
  try {
    return fn();
  } finally {
    setHandleForTests(ha);
  }
}

beforeEach(() => {
  resetRateLimits();
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

/** Finals on trk_01 with one finalist added against the ranking, two panelists, one score missing and the round closed with a reason; then published. */
function holdFinals() {
  const org = organizerA();
  const judges = (ha.sqlite.prepare("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").all() as { id: string }[]).map((r) => r.id);
  const round = openFinals(org, "evt_01", { track: "trk_01", n: 2 });
  const extra = (ha.sqlite.prepare("SELECT id FROM projects WHERE event_id = 'evt_01' AND track_id = 'trk_01' AND status = 'submitted' AND duplicate_of IS NULL ORDER BY id").all() as { id: string }[])
    .map((r) => r.id)
    .find((id) => !round.finalists.includes(id))!;
  addFinalist(org, "evt_01", round.id, { project: extra, reason: "Asked back by the jury" });
  setFinalsPanel(org, "evt_01", round.id, { judges: judges.slice(0, 2) });
  const keys = (ha.sqlite.prepare("SELECT key, scale_min AS lo, scale_max AS hi FROM rubric_criteria WHERE event_id = 'evt_01'").all() as { key: string; lo: number; hi: number }[]);
  const all = [...round.finalists, extra];
  all.forEach((p, i) => saveFinalsScore(actorIn(ha, judges[0]!), "evt_01", { finals: round.id, project: p, values: Object.fromEntries(keys.map((k) => [k.key, Math.max(k.lo, k.hi - i)])) }));
  // the second panelist scores all but the last: closed early, with a reason
  all.slice(0, -1).forEach((p, i) => saveFinalsScore(actorIn(ha, judges[1]!), "evt_01", { finals: round.id, project: p, values: Object.fromEntries(keys.map((k) => [k.key, Math.max(k.lo, k.hi - 2 + i)])) }));
  closeFinals(org, "evt_01", round.id, { reason: "One panelist had to leave" });
  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(org, "evt_01");
  return round;
}

describe("the finals move with the event", () => {
  it("fixtures.json carries them; a new portal exports the same file and publishes the same places", () => {
    const round = holdFinals();
    const fileA = JSON.parse(exportFile(organizerA(), "evt_01", "fixtures.json").body) as { finals?: { id: string; finalists: unknown[]; panel: unknown[]; scores: unknown[]; close_reason?: string }[] };
    expect(fileA.finals).toHaveLength(1);
    expect(fileA.finals![0]).toMatchObject({ id: round.id, close_reason: "One panelist had to leave" });
    expect(fileA.finals![0]!.finalists).toHaveLength(round.finalists.length + 1);
    expect(fileA.finals![0]!.scores).toHaveLength(round.finalists.length * 2 + 1);
    const resultsA = getPublishedResults("evt_01");

    const report = inB(() => importEventFile(actorIn(hb!, "usr_b", true), fileA));
    expect(report.restored?.finals).toEqual([{ round: round.id, finalists: round.finalists.length + 1, panel: 2, scores: round.finalists.length * 2 + 1 }]);
    const fileB = inB(() => JSON.parse(exportFile(actorIn(hb!, "usr_b", true), "evt_01", "fixtures.json").body));
    expect(fileB.finals).toEqual(fileA.finals);
    const resultsB = inB(() => getPublishedResults("evt_01"));
    if (!resultsA.published || !resultsB.published) throw new Error("not published");
    const places = (r: typeof resultsA) => (r.published ? r.tracks.find((t) => t.id === "trk_01")!.rows.map((x) => [x.projectId, x.place, x.finals ?? null]) : []);
    expect(places(resultsB)).toEqual(places(resultsA));
    expect(resultsB.finals).toEqual(resultsA.finals);
    // and it stays frozen there: the new portal's database refuses a change to a finals score
    expect(() => hb!.sqlite.prepare("UPDATE finals_score_items SET value = value").run()).toThrow(/results are published/);
  });

  it("known-bad: into the event that is here, a finals round it does not hold is refused whole (409 new_event_only); its own file imports back", () => {
    holdFinals();
    const file = JSON.parse(exportFile(organizerA(), "evt_01", "fixtures.json").body) as { finals: { id: string }[] };
    // its own export brings nothing new
    expect(() => importEventFile(organizerA(), file)).not.toThrow();
    const planted = { ...file, finals: [...file.finals, { ...file.finals[0]!, id: "fin_planted" }] };
    let caught: unknown;
    try {
      importEventFile(organizerA(), planted);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect({ status: (caught as HttpError).status, code: (caught as HttpError).code }).toEqual({ status: 409, code: "new_event_only" });
    expect((caught as HttpError).message).toContain("finals round");
  });

  it("an event with no finals: fixtures.json has no finals key", () => {
    const file = exportFile(organizerA(), "evt_01", "fixtures.json").body;
    expect(file).not.toContain('"finals"');
  });
});
