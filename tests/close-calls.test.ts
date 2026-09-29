import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { FixtureSchema, importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { ensureDemoOrganizer } from "@/server/checker";
import { auditLog, userRoles } from "@/server/db/schema";
import { HttpError } from "@/server/errors";
import { resetRateLimits } from "@/server/rate-limit";
import { CALL_LINE, DRAWS, closeCall, firstCounts, withDecidedWinner, type Contender } from "@/server/judging/decision";
import { competitionPlaces } from "@/lib/places";
import type { Actor } from "@/server/authz";

// The judges' decision on a close call (JUDGING.md, "Close calls and the judges' decision"): the P(first)
// module, the close-call check, the two audited choices, what publishing does with them, and the refusals.

let sessionCookie: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: vi.fn(), get: (name: string) => (name === "session" && sessionCookie ? { name, value: sessionCookie } : undefined), delete: vi.fn() }),
  headers: async () => new Headers(),
}));

const { closeCallsOf, getCloseCalls, settleCloseCall, undoCloseCall } = await import("@/server/dal/close-calls");
const { acceptUnderReviewed, decisions, dismissDuplicate, setJudgeOverride } = await import("@/server/dal/decisions");
const { requireEvent } = await import("@/server/dal/events");
const { getPublishedResults, publishResults } = await import("@/server/dal/results");
const { exportFile } = await import("@/server/dal/exports");
const { computeNormalization } = await import("@/server/dal/normalization");
const { createLoginSession } = await import("@/server/session");
const { importEventFile } = await import("@/server/dal/imports");
const listRoute = await import("@/app/api/events/[event]/close-calls/route");
const trackRoute = await import("@/app/api/events/[event]/close-calls/[track]/route");

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

// A small event whose scores carry a signal: in "Close" the two best projects are near each other, in
// "Clear" one project is far ahead. Four judges review every project; no judge is flat.
const J = ["jdg_1", "jdg_2", "jdg_3", "jdg_4"];
const LEVEL: Record<string, number[]> = {
  prj_a1: [5, 5, 4, 5],
  prj_a2: [5, 4, 5, 4],
  prj_a3: [3, 2, 3, 2],
  prj_a4: [2, 2, 1, 2],
  prj_a5: [1, 1, 1, 2],
  prj_b1: [5, 5, 5, 4],
  prj_b2: [1, 2, 1, 1],
  prj_b3: [2, 1, 1, 2],
};
function signalFixture() {
  const ids = Object.keys(LEVEL);
  return FixtureSchema.parse({
    event: { id: "evt_cc", name: "Close calls", submissions_close: "2026-03-01T18:00:00Z" },
    tracks: [
      { id: "trk_close", name: "Close" },
      { id: "trk_clear", name: "Clear" },
    ],
    judges: J.map((id, k) => ({ id, name: `Judge ${k + 1}`, email: `j${k + 1}@example.org`, tracks: ["trk_close", "trk_clear"] })),
    teams: ids.map((id) => ({ id: `tm_${id}`, name: `Team ${id}`, members: [`${id}@example.org`] })),
    projects: ids.map((id) => ({ id, team: `tm_${id}`, track: id.startsWith("prj_a") ? "trk_close" : "trk_clear", title: `Project ${id.slice(4).toUpperCase()}`, submitted_at: "2026-02-27T04:08:00Z" })),
    scores: J.flatMap((judge, k) =>
      ids.map((project) => {
        const v = LEVEL[project]![k]!;
        // one criterion off by one on alternate judges, so no judge scores every project the same
        return { judge, project, criteria: { functionality: v, quality: v, innovation: Math.max(1, Math.min(5, v + (k % 2 ? -1 : 1) * (project.endsWith("1") ? 0 : 0))) } };
      }),
    ),
  });
}

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  importFixtures(h.db, signalFixture(), { source: "upload", sha256: "evt_cc", now: NOW });
  ensureDemoOrganizer(h.db, "evt_cc", NOW);
  setHandleForTests(h);
  resetRateLimits();
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  sessionCookie = null;
});

function actorOf(userId: string): Actor {
  const u = h.sqlite.prepare("SELECT id, name, email, is_admin AS a FROM users WHERE id = ?").get(userId) as { id: string; name: string; email: string; a: number };
  const roles = h.db.select({ eventId: userRoles.eventId, role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, u.id)).all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: Boolean(u.a), roles, sessionKind: "login" };
}
const organizer = () => actorOf("usr_organizer");
const withRole = (eventId: string, role: "participant" | "judge") =>
  actorOf(h.db.select({ u: userRoles.userId }).from(userRoles).where(eq(userRoles.role, role)).all().find((r) => roleIn(r.u, eventId, role))!.u);
const roleIn = (userId: string, eventId: string, role: string) =>
  Boolean(h.sqlite.prepare("SELECT 1 FROM user_roles WHERE user_id = ? AND event_id = ? AND role = ?").get(userId, eventId, role));

function statusOf(call: () => unknown): { status: number; code?: string } {
  try {
    call();
  } catch (err) {
    if (err instanceof HttpError) return { status: err.status, code: err.code };
    throw err;
  }
  return { status: 200 };
}
const auditOf = (action: string) => h.db.select().from(auditLog).where(eq(auditLog.action, action)).all();
const eventOf = (id: string) => requireEvent(h.db, id);
/** The sample event's own three decisions, settled as the hand checks settle them before publishing. */
function settleSampleDecisions() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
}

// ---------------------------------------------------------------------------
// The P(first) module
// ---------------------------------------------------------------------------

describe("P(first): each project's chance of really being first", () => {
  const rows: Contender[] = [
    { id: "p3", score: 3.1, se: 0.3 },
    { id: "p1", score: 3.4, se: 0.35 },
    { id: "p2", score: 3.3, se: 0.3 },
    { id: "p4", score: 2.2, se: 0.4 },
  ];

  it("is deterministic: the same rows give the same counts, in any order they arrive", () => {
    const a = firstCounts(rows)!;
    const b = firstCounts([...rows].reverse())!;
    expect([...a].sort()).toEqual([...b].sort());
    expect([...a.values()].reduce((s, n) => s + n, 0)).toBe(DRAWS);
    expect(closeCall(rows)).toEqual(closeCall([rows[2]!, rows[0]!, rows[3]!, rows[1]!]));
  });

  it("names the winner when the scores are far apart (positive control)", () => {
    const cc = closeCall([
      { id: "a", score: 4.6, se: 0.2 },
      { id: "b", score: 2.0, se: 0.2 },
      { id: "c", score: 1.8, se: 0.2 },
    ])!;
    expect(cc.callable).toBe(true);
    expect(cc.close).toEqual(["a"]);
    expect(cc.chances[0]).toEqual({ id: "a", p: 1 });
  });

  it("known-bad: a flat field (equal scores, equal ±) must not declare a winner", () => {
    const flat = ["a", "b", "c", "d"].map((id) => ({ id, score: 3, se: 0.3 }));
    const cc = closeCall(flat)!;
    expect(cc.callable).toBe(false);
    expect(cc.top).toEqual(["a", "b", "c", "d"]);
    for (const c of cc.chances) expect(Math.abs(c.p - 0.25)).toBeLessThan(0.04);
    // the 95 % set of a flat field holds every project
    expect(cc.close.sort()).toEqual(["a", "b", "c", "d"]);
    // and a module that ignored the ± (P(first) = 1 for the top) would have declared: the check sees the difference
    expect(closeCall(flat.map((r, i) => ({ ...r, score: 3 + (i === 0 ? 1e-6 : 0), se: 0 })))!.callable).toBe(true);
  });

  it("makes no call at all without a ± (a missing ± would read as certainty) or with one project", () => {
    expect(closeCall([{ id: "a", score: 4, se: null }, { id: "b", score: 1, se: 0.2 }])).toBeNull();
    expect(closeCall([{ id: "a", score: 4, se: 0.2 }])).toBeNull();
  });

  it("holds the line at 95 % of the draws exactly", () => {
    expect(CALL_LINE).toBe(0.95);
    expect(DRAWS).toBe(4000);
    // two projects whose gap is 1.645 standard errors of the difference: P(first) sits right at 95 %
    const se = 0.2;
    const gap = 1.6449 * Math.sqrt(2) * se;
    const cc = closeCall([{ id: "a", score: 3 + gap, se }, { id: "b", score: 3, se }])!;
    expect(Math.abs(cc.chances[0]!.p - 0.95)).toBeLessThan(0.012);
    expect(cc.callable).toBe(cc.chances[0]!.p >= 0.95);
  });

  it("puts the decided winner first and keeps every other row in the order it came in", () => {
    const r = [{ projectId: "a" }, { projectId: "b" }, { projectId: "c" }, { projectId: "d" }];
    expect(withDecidedWinner(r, "c").map((x) => x.projectId)).toEqual(["c", "a", "b", "d"]);
    expect(withDecidedWinner(r, "zz").map((x) => x.projectId)).toEqual(["a", "b", "c", "d"]);
  });
});

// ---------------------------------------------------------------------------
// Close-call detection
// ---------------------------------------------------------------------------

describe("the close-call check on an event", () => {
  it("finds every track of the sample event too close to call, before and after its decisions are settled, and only advises: no signal", () => {
    for (const settle of [false, true]) {
      if (settle) settleSampleDecisions();
      const calls = closeCallsOf(h.db, eventOf("evt_01"));
      expect(calls.length).toBe(h.sqlite.prepare("SELECT count(*) AS n FROM tracks WHERE event_id = 'evt_01'").pluck().get());
      for (const c of calls) {
        expect(c.callable).toBe(false);
        expect(c.signal).toBe(false);
        expect(c.required).toBe(false);
        const topP = c.projects.find((p) => p.id === c.top[0])!.p;
        expect(topP).toBeLessThan(0.95);
        expect(topP).toBeGreaterThan(0.2);
      }
    }
    // so the sample event's decisions are what they were: no close call among them
    const list = decisions(h.db, eventOf("evt_01"), computeNormalization(h.db, eventOf("evt_01")));
    expect(list.some((d) => d.kind === "close_call")).toBe(false);
  });

  it("on scores with a signal, a close top is a decision to settle and a clear top is none", () => {
    const calls = closeCallsOf(h.db, eventOf("evt_cc"));
    const close = calls.find((c) => c.trackId === "trk_close")!;
    const clear = calls.find((c) => c.trackId === "trk_clear")!;
    expect(close.signal).toBe(true);
    expect(close.callable).toBe(false);
    expect(close.required).toBe(true);
    expect(close.close.sort()).toEqual(["prj_a1", "prj_a2"]);
    expect(clear.callable).toBe(true);
    expect(clear.required).toBe(false);
    const open = decisions(h.db, eventOf("evt_cc"), computeNormalization(h.db, eventOf("evt_cc"))).filter((d) => !d.resolved);
    expect(open.map((d) => d.key)).toEqual(["close:trk_close"]);
    expect(statusOf(() => publishResults(organizer(), "evt_cc"))).toEqual({ status: 409, code: "decisions_open" });
  });
});

// ---------------------------------------------------------------------------
// The two choices and publishing
// ---------------------------------------------------------------------------

describe("settling a close call", () => {
  it("keep the ranking's winner: one click settles it, and the published places are the score order", () => {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "keep" });
    expect(auditOf("results.close_call")).toHaveLength(1);
    publishResults(organizer(), "evt_cc");
    const r = getPublishedResults("evt_cc");
    if (!r.published) throw new Error("not published");
    const t = r.tracks.find((x) => x.id === "trk_close")!;
    expect(t.decision).toBeUndefined();
    expect(t.rows[0]!.projectId).toBe("prj_a1");
    expect(t.rows.some((x) => "decided" in x)).toBe(false);
  });

  it("the judges' decision changes only that track's first place; the rest keep their score order, and the other track is untouched", () => {
    const before = computeNormalization(h.db, eventOf("evt_cc"));
    const scoreOrder = before.projects.filter((p) => p.trackId === "trk_close").map((p) => p.id);
    expect(scoreOrder[0]).toBe("prj_a1");
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2", reason: "The judges found its demo worked end to end." });
    publishResults(organizer(), "evt_cc");
    const r = getPublishedResults("evt_cc");
    if (!r.published) throw new Error("not published");
    const t = r.tracks.find((x) => x.id === "trk_close")!;
    expect(t.rows.map((x) => x.projectId)).toEqual(["prj_a2", ...scoreOrder.filter((id) => id !== "prj_a2")]);
    expect(t.rows[0]!.decided).toBe(true);
    expect(t.rows[0]!.place).toBe(1);
    expect(t.rows[1]!.place).toBe(2);
    expect(competitionPlaces(t.rows).map((p) => p.place)).toEqual([1, 2, 3, 4, 5]);
    expect(t.decision!.reason).toBe("The judges found its demo worked end to end.");
    expect(t.decision!.scoreOrder).toEqual(scoreOrder);
    expect(t.decision!.close.map((c) => c.id).sort()).toEqual(["prj_a1", "prj_a2"]);
    // the scores themselves do not change
    expect(t.rows.find((x) => x.projectId === "prj_a1")!.score).toBeCloseTo(before.projects.find((p) => p.id === "prj_a1")!.score!, 12);
    const clear = r.tracks.find((x) => x.id === "trk_clear")!;
    expect(clear.decision).toBeUndefined();
    expect(clear.rows[0]!.projectId).toBe("prj_b1");
    // the certificate follows the published place
    expect(competitionPlaces(t.rows)[0]).toEqual({ place: 1, joint: false });
  });

  it("refuses a winner outside the close projects, the ranking's own winner, a missing reason, a clear track and an unknown one", () => {
    const org = organizer();
    expect(statusOf(() => settleCloseCall(org, "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a3", reason: "because" })).status).toBe(422);
    expect(statusOf(() => settleCloseCall(org, "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a1", reason: "because" })).status).toBe(422);
    expect(statusOf(() => settleCloseCall(org, "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2" })).status).toBe(422);
    expect(statusOf(() => settleCloseCall(org, "evt_cc", "trk_clear", { mode: "keep" }))).toEqual({ status: 409, code: "not_a_close_call" });
    expect(statusOf(() => settleCloseCall(org, "evt_cc", "trk_nope", { mode: "keep" })).status).toBe(404);
    expect(auditOf("results.close_call")).toHaveLength(0);
  });

  it("a choice that no longer fits the scores is open again", () => {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "keep" });
    const settings = JSON.parse((h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_cc'").get() as { settings: string }).settings);
    settings.closeCalls[0].top = ["prj_a2"]; // as if the ranking's first place had changed since
    h.sqlite.prepare("UPDATE events SET settings = ? WHERE id = 'evt_cc'").run(JSON.stringify(settings));
    const d = decisions(h.db, eventOf("evt_cc"), computeNormalization(h.db, eventOf("evt_cc"))).find((x) => x.kind === "close_call")!;
    expect(d.resolved).toBeNull();
    expect(d.kind === "close_call" && d.stale).toMatch(/first place changed/);
  });

  // A judges' decision is made about the first place it saw. Rewriting the stored `top` is the cheapest way to make the
  // ranking's first place move under a stored choice (as leaving out a flat judge can); the scores stay as they are.
  function judgesChoiceSeenOn(top: string[], winnerId: string) {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2", reason: "Written about the project then first." });
    const settings = JSON.parse((h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_cc'").get() as { settings: string }).settings);
    Object.assign(settings.closeCalls[0], { top, winnerId });
    h.sqlite.prepare("UPDATE events SET settings = ? WHERE id = 'evt_cc'").run(JSON.stringify(settings));
  }
  const closeDecision = () => decisions(h.db, eventOf("evt_cc"), computeNormalization(h.db, eventOf("evt_cc"))).find((x) => x.kind === "close_call")!;

  it("a judges' decision goes stale when another project is now first: its reason was written about the old first place", () => {
    // decided while prj_a3 led; prj_a1 leads now, prj_a2 is still a close project
    judgesChoiceSeenOn(["prj_a3"], "prj_a2");
    const d = closeDecision();
    expect(d.resolved).toBeNull();
    expect(d.kind === "close_call" && d.stale).toMatch(/first place changed/);
    expect(statusOf(() => publishResults(organizer(), "evt_cc"))).toEqual({ status: 409, code: "decisions_open" });
  });

  it("a judges' decision goes stale when the project it named is now first by score: no decision is claimed the scores made", () => {
    // decided for prj_a1 while prj_a2 led; prj_a1 now leads by score
    judgesChoiceSeenOn(["prj_a2"], "prj_a1");
    const d = closeDecision();
    expect(d.resolved).toBeNull();
    expect(d.kind === "close_call" && d.stale).toMatch(/first place changed/);
    expect(statusOf(() => publishResults(organizer(), "evt_cc"))).toEqual({ status: 409, code: "decisions_open" });
  });

  it("positive control: a judges' decision on the first place it saw stays in force and is published", () => {
    judgesChoiceSeenOn(["prj_a1"], "prj_a2");
    expect(closeDecision().resolved).toBe("judges");
    publishResults(organizer(), "evt_cc");
    const r = getPublishedResults("evt_cc");
    if (!r.published) throw new Error("not published");
    expect(r.tracks.find((x) => x.id === "trk_close")!.rows[0]!.projectId).toBe("prj_a2");
  });

  it("undo takes the choice back, and the last undo leaves the settings as they were before any choice", () => {
    const before = (h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_cc'").get() as { settings: string }).settings;
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "keep" });
    expect(undoCloseCall(organizer(), "evt_cc", "trk_close")).toEqual({ trackId: "trk_close", undone: true });
    expect((h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_cc'").get() as { settings: string }).settings).toBe(before);
    expect(auditOf("results.close_call_undo")).toHaveLength(1);
    expect(undoCloseCall(organizer(), "evt_cc", "trk_close")).toEqual({ trackId: "trk_close", undone: false });
    expect(auditOf("results.close_call_undo")).toHaveLength(1);
  });

  it("is frozen by publishing, in the app and in the database", () => {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2", reason: "The judges deliberated." });
    publishResults(organizer(), "evt_cc");
    expect(statusOf(() => settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "keep" }))).toEqual({ status: 409, code: "results_published" });
    expect(statusOf(() => undoCloseCall(organizer(), "evt_cc", "trk_close"))).toEqual({ status: 409, code: "results_published" });
    // the published results read the decision from the run, which the database keeps append-only
    const params = (h.sqlite.prepare("SELECT params FROM normalization_runs WHERE event_id = 'evt_cc'").get() as { params: string }).params;
    expect(JSON.parse(params).judgesDecisions).toEqual([expect.objectContaining({ trackId: "trk_close", winnerId: "prj_a2", reason: "The judges deliberated." })]);
    expect(() => h.sqlite.prepare("UPDATE normalization_runs SET params = '{}' WHERE event_id = 'evt_cc'").run()).toThrow();
    expect(() => h.sqlite.prepare("DELETE FROM normalization_runs WHERE event_id = 'evt_cc'").run()).toThrow();
  });

  it("a judges' decision on scores without a signal is allowed and published, though never required", () => {
    const calls = closeCallsOf(h.db, eventOf("evt_01"));
    const c = calls[0]!;
    const winner = c.close.find((id) => id !== c.top[0])!;
    settleCloseCall(organizer(), "evt_01", c.trackId, { mode: "judges", winnerId: winner, reason: "Judges' deliberation on the demo." });
    const d = decisions(h.db, eventOf("evt_01"), computeNormalization(h.db, eventOf("evt_01"))).filter((x) => x.kind === "close_call");
    expect(d).toHaveLength(1);
    expect(d[0]!.resolved).toBe("judges");
  });
});

// ---------------------------------------------------------------------------
// No decision: today's output, byte for byte
// ---------------------------------------------------------------------------

describe("an event with no close-call choice", () => {
  it("publishes exactly what it did before close calls existed: no new key in the run, the results or the exports", () => {
    settleSampleDecisions();
    const settingsBefore = (h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_01'").get() as { settings: string }).settings;
    publishResults(organizer(), "evt_01");
    const run = h.sqlite.prepare("SELECT params FROM normalization_runs WHERE event_id = 'evt_01'").get() as { params: string };
    expect(run.params).not.toContain("judgesDecisions");
    const r = getPublishedResults("evt_01");
    const text = JSON.stringify(r);
    expect(text).not.toContain("decided");
    expect(text).not.toContain("\"decision\"");
    // places are the score order's, as before
    if (!r.published) throw new Error("not published");
    for (const t of r.tracks) for (let i = 1; i < t.rows.length; i++) expect(t.rows[i - 1]!.score! >= t.rows[i]!.score!).toBe(true);
    const settingsAfter = JSON.parse((h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_01'").get() as { settings: string }).settings);
    expect(Object.keys(settingsAfter).sort()).toEqual([...Object.keys(JSON.parse(settingsBefore)), "publishedRunId"].sort());
    for (const file of ["event.json", "normalized.csv", "fixtures.json"]) expect(exportFile(organizer(), "evt_01", file).body).not.toMatch(/closeCalls|judgesDecisions/);
  });

  it("known-bad guard: with a decision, the same checks do see the new keys", () => {
    settleSampleDecisions();
    const c = closeCallsOf(h.db, eventOf("evt_01"))[0]!;
    settleCloseCall(organizer(), "evt_01", c.trackId, { mode: "judges", winnerId: c.close.find((id) => id !== c.top[0])!, reason: "Deliberated." });
    publishResults(organizer(), "evt_01");
    const run = h.sqlite.prepare("SELECT params FROM normalization_runs WHERE event_id = 'evt_01'").get() as { params: string };
    expect(run.params).toContain("judgesDecisions");
    expect(JSON.stringify(getPublishedResults("evt_01"))).toContain("decided");
    expect(exportFile(organizer(), "evt_01", "event.json").body).toMatch(/closeCalls/);
  });
});

// ---------------------------------------------------------------------------
// Who may: 401 without a session, 403 without the right, organizers through
// ---------------------------------------------------------------------------

describe("the close-call routes refuse who may not", () => {
  const ctx = (event: string, track?: string) => ({ params: Promise.resolve(track ? { event, track } : { event }) }) as never;
  const put = (body: unknown) => new Request("http://localhost:8080/api/events/evt_cc/close-calls/trk_close", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const as = (userId: string | null) => {
    sessionCookie = userId ? createLoginSession(h.db, userId).token : null;
  };

  it("answers 401 with no session on every route", async () => {
    as(null);
    expect((await listRoute.GET(new Request("http://localhost:8080/api/events/evt_cc/close-calls"), ctx("evt_cc"))).status).toBe(401);
    expect((await trackRoute.PUT(put({ mode: "keep" }), ctx("evt_cc", "trk_close"))).status).toBe(401);
    expect((await trackRoute.DELETE(new Request("http://localhost:8080/x", { method: "DELETE" }), ctx("evt_cc", "trk_close"))).status).toBe(401);
  });

  it("answers 403 to a participant and a judge, and audits each refusal; nothing is stored", async () => {
    for (const who of [withRole("evt_cc", "participant"), withRole("evt_cc", "judge")]) {
      as(who.userId);
      const refusedBefore = auditOf("authz.refused").length;
      expect((await listRoute.GET(new Request("http://localhost:8080/api/events/evt_cc/close-calls"), ctx("evt_cc"))).status).toBe(403);
      expect((await trackRoute.PUT(put({ mode: "keep" }), ctx("evt_cc", "trk_close"))).status).toBe(403);
      expect((await trackRoute.DELETE(new Request("http://localhost:8080/x", { method: "DELETE" }), ctx("evt_cc", "trk_close"))).status).toBe(403);
      expect(auditOf("authz.refused").length).toBe(refusedBefore + 3);
    }
    expect(eventOf("evt_cc").settings.closeCalls).toBeUndefined();
  });

  it("positive control: the organizer reads, settles and undoes through the same routes", async () => {
    as("usr_organizer");
    const list = await listRoute.GET(new Request("http://localhost:8080/api/events/evt_cc/close-calls"), ctx("evt_cc"));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { tracks: { trackId: string; required: boolean }[] };
    expect(body.tracks.find((t) => t.trackId === "trk_close")!.required).toBe(true);
    expect((await trackRoute.PUT(put({ mode: "judges", winnerId: "prj_a2", reason: "Deliberated." }), ctx("evt_cc", "trk_close"))).status).toBe(200);
    expect(eventOf("evt_cc").settings.closeCalls).toHaveLength(1);
    expect((await trackRoute.DELETE(new Request("http://localhost:8080/x", { method: "DELETE" }), ctx("evt_cc", "trk_close"))).status).toBe(200);
    expect(eventOf("evt_cc").settings.closeCalls).toBeUndefined();
  });

  it("the read in the data layer refuses the same way (the rule, not only the route)", () => {
    expect(statusOf(() => getCloseCalls(null, "evt_cc")).status).toBe(401);
    expect(statusOf(() => getCloseCalls(withRole("evt_cc", "judge"), "evt_cc")).status).toBe(403);
    expect(statusOf(() => settleCloseCall(null, "evt_cc", "trk_close", { mode: "keep" })).status).toBe(401);
    expect(statusOf(() => settleCloseCall(withRole("evt_cc", "participant"), "evt_cc", "trk_close", { mode: "keep" })).status).toBe(403);
    expect(statusOf(() => getCloseCalls(organizer(), "evt_cc")).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The event file carries the choice, and the published decision with its run
// ---------------------------------------------------------------------------

describe("the close-call choice travels in the event's own file", () => {
  let hb: Handle | null = null;
  afterEach(() => {
    hb?.sqlite.close();
    hb = null;
  });
  function inB<T>(fn: () => T): T {
    if (!hb) {
      hb = openDatabase(":memory:");
      runMigrations(hb, path.join(process.cwd(), "drizzle"));
      hb.sqlite.prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES ('usr_b', 'b@example.org', 'Admin B', NULL, 1, ?)").run(NOW);
    }
    setHandleForTests(hb);
    try {
      return fn();
    } finally {
      setHandleForTests(h);
    }
  }
  const adminB = (): Actor => ({ userId: "usr_b", name: "Admin B", email: "b@example.org", isAdmin: true, roles: [], sessionKind: "login" });
  const fileOf = () => exportFile(organizer(), "evt_cc", "fixtures.json").body;

  it("before publishing: the judges' decision is restored on the new portal, and the file comes back the same", () => {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2", reason: "The judges deliberated." });
    const a = fileOf();
    expect(JSON.parse(a).decisions.close_calls).toEqual([
      expect.objectContaining({ track: "trk_close", mode: "judges", winner: "prj_a2", reason: "The judges deliberated.", top: ["prj_a1"] }),
    ]);
    const report = inB(() => importEventFile(adminB(), JSON.parse(a)));
    expect(report.skipped).toEqual([]);
    expect(inB(() => requireEvent(hb!.db, "evt_cc").settings.closeCalls)).toEqual(eventOf("evt_cc").settings.closeCalls);
    expect(inB(() => exportFile(adminB(), "evt_cc", "fixtures.json").body)).toBe(a);
    // and on B it is a settled decision, as on A
    const onB = inB(() => decisions(hb!.db, requireEvent(hb!.db, "evt_cc"), computeNormalization(hb!.db, requireEvent(hb!.db, "evt_cc"))).find((d) => d.kind === "close_call"));
    expect(onB?.resolved).toBe("judges");
  });

  it("after publishing: the new portal shows the same winner by the judges' decision, read from the published run", () => {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2", reason: "The judges deliberated." });
    publishResults(organizer(), "evt_cc");
    const file = JSON.parse(fileOf());
    inB(() => importEventFile(adminB(), file));
    // (the seal names a publishing entry of each portal's own log; the track order here rests on equal positions, compared by id)
    const shown = (r: ReturnType<typeof getPublishedResults>) => (r.published ? { ...r, anchor: undefined, tracks: [...r.tracks].sort((x, y) => (x.id < y.id ? -1 : 1)) } : r);
    const onB = inB(() => getPublishedResults("evt_cc"));
    expect(shown(onB)).toEqual(shown(getPublishedResults("evt_cc")));
    if (!onB.published) throw new Error("not published on B");
    expect(onB.tracks.find((t) => t.id === "trk_close")!.decision!.winnerId).toBe("prj_a2");
  });

  it("known-bad: a file whose choice names a project the file does not carry restores no choice, and says so", () => {
    settleCloseCall(organizer(), "evt_cc", "trk_close", { mode: "judges", winnerId: "prj_a2", reason: "The judges deliberated." });
    const file = JSON.parse(fileOf());
    file.decisions.close_calls[0].winner = "prj_elsewhere";
    const report = inB(() => importEventFile(adminB(), file));
    expect(JSON.stringify(report.skipped)).toMatch(/close_call:trk_close/);
    expect(inB(() => requireEvent(hb!.db, "evt_cc").settings.closeCalls)).toBeUndefined();
  });
});
