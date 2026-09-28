import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditLog, userRoles } from "@/server/db/schema";
import { verifyAuditChain } from "@/server/audit";
import { ensureDemoOrganizer } from "@/server/checker";
import { HttpError } from "@/server/errors";
import { requireEvent } from "@/server/dal/events";
import { METHOD, computeNormalization } from "@/server/dal/normalization";
import {
  acceptUnderReviewed,
  decisions,
  dismissDuplicate,
  mergeDuplicate,
  revokeJudgeOverride,
  setJudgeOverride,
  undoAcceptUnderReviewed,
  undoNotDuplicate,
  unmergeDuplicate,
  type Decision,
} from "@/server/dal/decisions";
import { getNormalization, getPublishedResults, publishResults } from "@/server/dal/results";
import { getSubmissions } from "@/server/dal/submissions";
import { castBallot, enterVoting } from "@/server/dal/voting";
import { getCommunityResults, makeVotingLink, saveVotingSettings } from "@/server/dal/voting-organizer";
import { getAuditLog } from "@/server/dal/audit-log";
import { exportFile } from "@/server/dal/exports";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the normalization DAL goes through getDb()
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

function expectHttpError(call: () => unknown, status: number, code: string) {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to throw").toBeInstanceOf(HttpError);
  const error = caught as HttpError;
  expect(error.status).toBe(status);
  expect(error.code).toBe(code);
  return error;
}

const count = (sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n;
const countIn = (hx: Handle, sql: string) => (hx.sqlite.prepare(sql).get() as { n: number }).n;
const nOf = (sql: string, ...params: (string | number)[]) => (h.sqlite.prepare(sql).get(...params) as { n: number }).n;
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();
const auditOf = (action: string) => auditRows().filter((r) => r.action === action);

function actorIn(hx: Handle, userId: string): Actor {
  const u = hx.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as
    | { id: string; name: string; email: string }
    | undefined;
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = hx.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}

const actorById = (userId: string) => actorIn(h, userId);
const organizer = () => actorById("usr_organizer");

function addUser(id: string, email: string, name: string): Actor {
  h.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)")
    .run(id, email, name, NOW);
  return actorById(id);
}

const eventOf = () => requireEvent(h.db, "evt_01");
const eventRow = () =>
  h.sqlite.prepare("SELECT results_published_at AS resultsPublishedAt, settings FROM events WHERE id = 'evt_01'").get() as {
    resultsPublishedAt: string | null;
    settings: string;
  };

const activeOverrideCount = (judgeUserId: string) =>
  nOf("SELECT count(*) AS n FROM judge_overrides WHERE judge_user_id = ? AND revoked_at IS NULL", judgeUserId);

const isFlat = (d: Decision): d is Extract<Decision, { kind: "flat_judge" }> => d.kind === "flat_judge";
const isDuplicate = (d: Decision): d is Extract<Decision, { kind: "duplicate" }> => d.kind === "duplicate";
const isUnder = (d: Decision): d is Extract<Decision, { kind: "under_reviewed" }> => d.kind === "under_reviewed";

type MergeView = {
  keptScore: number | null;
  duplicateOf: string | null;
  dupRankNormalized: number | null;
  ranked: number;
  scoresBefore: number;
  scoresAfter: number;
};

/** Merge the Dry Harbour pair in a database of its own, so the two directions never touch each other. */
function mergeInFreshDb(keepId: string, duplicateId: string): MergeView {
  const hx = openDatabase(":memory:");
  runMigrations(hx, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(hx.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(hx.db, "evt_01", NOW);
  setHandleForTests(hx); // mergeDuplicate goes through getDb()
  try {
    const scoresBefore = countIn(hx, "SELECT count(*) AS n FROM scores");
    mergeDuplicate(actorIn(hx, "usr_organizer"), "evt_01", { keepId, duplicateId });
    const n = computeNormalization(hx.db, requireEvent(hx.db, "evt_01"));
    const kept = n.projects.find((p) => p.id === keepId)!;
    const dup = n.projects.find((p) => p.id === duplicateId)!;
    return {
      keptScore: kept.score,
      duplicateOf: dup.duplicateOf,
      dupRankNormalized: dup.rankNormalized,
      ranked: n.ranked,
      scoresBefore,
      scoresAfter: countIn(hx, "SELECT count(*) AS n FROM scores"),
    };
  } finally {
    setHandleForTests(h); // back to this test's own database
    hx.sqlite.close();
  }
}

describe("the fresh fixture's decisions", () => {
  it("returns exactly three open decisions — the flat judge, the Dry Harbour duplicate, the under-reviewed project — with the exact numbers", () => {
    const n = computeNormalization(h.db, eventOf());
    expect(n.ranked).toBe(41);
    expect(n.projects.filter((p) => !p.duplicateOf)).toHaveLength(41);
    expect(n.variance.k).toBeCloseTo(42.59, 1);

    const ds = decisions(h.db, eventOf());
    console.log("flat judges:", ds.filter((d) => d.kind === "flat_judge").length);
    expect(ds.filter((d) => d.kind === "flat_judge")).toHaveLength(1);
    expect(ds).toHaveLength(3);
    expect(ds.map((d) => d.kind).sort()).toEqual(["duplicate", "flat_judge", "under_reviewed"]);
    expect(ds.every((d) => d.resolved === null)).toBe(true);

    const flat = ds.find(isFlat)!;
    expect(flat.judgeId).toBe("jdg_07");
    expect(flat.name).toBe("Iva Petrova");
    expect(flat.reviews).toBe(3);
    expect(flat.vector).toEqual([4, 4, 4]);
    expect(flat.movesIfOut).toBe(19);
    expect(flat.biggest).toEqual({ title: "Small Relay", from: 14, to: 30 });

    const dup = ds.find(isDuplicate)!;
    expect(dup.title).toBe("Dry Harbour");
    expect(dup.copies.map((c) => c.id).sort()).toEqual(["prj_07", "prj_41"]);

    const under = ds.find(isUnder)!;
    expect(under.projectId).toBe("prj_19");
    expect(under.n).toBe(1);
  });
});

describe("getNormalization", () => {
  it("refuses no session with 401 and a participant with 403 (one authz.refused row); for the organizer the receipt adds up", () => {
    const participant = addUser("usr_spectator", "spectator@example.org", "Spectator");
    const before = auditRows().length;

    expectHttpError(() => getNormalization(null, "evt_01"), 401, "unauthenticated");
    expect(auditRows().length).toBe(before); // the 401 writes nothing

    expectHttpError(() => getNormalization(participant, "evt_01"), 403, "not_an_organizer");
    const rows = auditRows();
    expect(rows).toHaveLength(before + 1); // the refusal is the only new row
    expect(rows.filter((r) => r.action === "authz.refused")).toHaveLength(1);

    const view = getNormalization(organizer(), "evt_01");
    const n = view.normalization;
    expect(n.variance.k).toBeCloseTo(42.59, 1);
    expect(n.excluded).toEqual(["jdg_07"]);

    // each project's normalized score is the mean of its kept receipts' adjusted values
    for (const row of n.projects) {
      if (row.duplicateOf) continue;
      const kept = row.receipts.filter((r) => !r.excluded);
      if (row.score === null) {
        expect(kept).toHaveLength(0);
        continue;
      }
      expect(kept.length).toBeGreaterThan(0);
      const meanAdjusted = kept.reduce((s, r) => s + r.adjusted, 0) / kept.length;
      expect(meanAdjusted).toBeCloseTo(row.score, 9);
    }
  });
});

describe("setJudgeOverride / revokeJudgeOverride", () => {
  it("known-bad: an override without a reason is 422 and writes no override row and no audit row", () => {
    const before = auditRows().length;
    expectHttpError(
      () => setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "include", reason: "" }),
      422,
      "invalid",
    );
    expect(count("SELECT count(*) AS n FROM judge_overrides")).toBe(0);
    expect(auditRows().length).toBe(before);
  });

  it("an include override with a reason reinstates the flagged judge, is audited, and the chain verifies", () => {
    const { id } = setJudgeOverride(organizer(), "evt_01", {
      judgeUserId: "jdg_07",
      mode: "include",
      reason: "Scores checked by hand, they stand",
    });
    expect(id).toMatch(/^ovr_/);
    expect(activeOverrideCount("jdg_07")).toBe(1);

    const rows = auditOf("judge.override");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe("jdg_07");
    expect(rows[0]!.before).toBeNull();
    expect(rows[0]!.after).toMatchObject({ mode: "include", reason: "Scores checked by hand, they stand" });

    expect(computeNormalization(h.db, eventOf()).excluded).not.toContain("jdg_07");
    const flat = decisions(h.db, eventOf()).find(isFlat)!;
    expect(flat.resolved).toEqual({ mode: "include", reason: "Scores checked by hand, they stand" });
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("a second override revokes the first (its revoked_at is set, the audit row's before holds the old mode); revoking twice writes nothing", () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "include", reason: "Scores checked by hand, they stand" });
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Second look says leave them out" });

    expect(activeOverrideCount("jdg_07")).toBe(1);
    const active = h.sqlite
      .prepare("SELECT mode FROM judge_overrides WHERE judge_user_id = 'jdg_07' AND revoked_at IS NULL")
      .get() as { mode: string };
    expect(active.mode).toBe("exclude");
    const revoked = h.sqlite
      .prepare("SELECT revoked_at AS r FROM judge_overrides WHERE judge_user_id = 'jdg_07' AND revoked_at IS NOT NULL")
      .all() as { r: string }[];
    expect(revoked).toHaveLength(1);

    const last = auditOf("judge.override").at(-1)!;
    expect(last.before).toMatchObject({ mode: "include" });
    expect(last.after).toMatchObject({ mode: "exclude" });
    expect(computeNormalization(h.db, eventOf()).excluded).toContain("jdg_07");

    const first = revokeJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07" });
    expect(first).toEqual({ revoked: true });
    expect(activeOverrideCount("jdg_07")).toBe(0);
    expect(computeNormalization(h.db, eventOf()).excluded).toContain("jdg_07"); // the flat rule applies again

    const revokesBefore = auditOf("judge.override_revoke").length;
    const again = revokeJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07" });
    expect(again).toEqual({ revoked: false });
    expect(auditOf("judge.override_revoke")).toHaveLength(revokesBefore); // nothing changed, nothing audited
  });

  it("an exclude override on an unflagged judge puts that judge out", () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_24", mode: "exclude", reason: "Conflict surfaced after assignment" });
    expect(computeNormalization(h.db, eventOf()).excluded).toContain("jdg_24");
  });

  it("known-bad: a user who is not a judge of this event gets 404 and no override row", () => {
    const civilian = addUser("usr_civilian", "civilian@example.org", "Civilian");
    expectHttpError(
      () => setJudgeOverride(organizer(), "evt_01", { judgeUserId: civilian.userId, mode: "include", reason: "Not a judge here" }),
      404,
      "not_found",
    );
    expect(count("SELECT count(*) AS n FROM judge_overrides")).toBe(0);
  });
});

describe("mergeDuplicate / unmergeDuplicate / dismissDuplicate", () => {
  it("known-bad: unmerged, the two Dry Harbour copies hold different raw ranks", () => {
    const n = computeNormalization(h.db, eventOf());
    const a = n.projects.find((p) => p.id === "prj_07")!;
    const b = n.projects.find((p) => p.id === "prj_41")!;
    expect(a.rankRaw).not.toBeNull();
    expect(b.rankRaw).not.toBeNull();
    expect(a.rankRaw).not.toBe(b.rankRaw);
  });

  it("whichever copy is kept, the kept copy's normalized score and the ranked count are the same and no score row is deleted", () => {
    const keep07 = mergeInFreshDb("prj_07", "prj_41");
    const keep41 = mergeInFreshDb("prj_41", "prj_07");

    expect(keep07.ranked).toBe(40);
    expect(keep41.ranked).toBe(40);
    expect(keep07.keptScore).not.toBeNull();
    expect(keep41.keptScore).toBeCloseTo(keep07.keptScore!, 9);
    expect(keep07.duplicateOf).toBe("prj_07"); // prj_41 was merged into prj_07
    expect(keep41.duplicateOf).toBe("prj_41"); // and prj_07 into prj_41
    expect(keep07.dupRankNormalized).toBeNull();
    expect(keep41.dupRankNormalized).toBeNull();
    expect(keep07.scoresAfter).toBe(keep07.scoresBefore);
    expect(keep41.scoresAfter).toBe(keep41.scoresBefore);
  });

  it("known-bad: merging a project into itself is 409 same_project, and an already merged copy is 409 already_merged", () => {
    expectHttpError(() => mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_07" }), 409, "same_project");
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    expectHttpError(() => mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" }), 409, "already_merged");
    expectHttpError(() => mergeDuplicate(organizer(), "evt_01", { keepId: "prj_41", duplicateId: "prj_07" }), 409, "already_merged");
  });

  it("unmerge restores 41 ranked projects and writes one project.unmerge row", () => {
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    expect(computeNormalization(h.db, eventOf()).ranked).toBe(40);
    // the decision names the merged copy, so the overview offers Undo for that one only
    const copies = decisions(h.db, eventOf()).find(isDuplicate)!.copies;
    expect(Object.fromEntries(copies.map((c) => [c.id, c.duplicateOf]))).toEqual({ prj_07: null, prj_41: "prj_07" });

    unmergeDuplicate(organizer(), "evt_01", { duplicateId: "prj_41" });

    expect(computeNormalization(h.db, eventOf()).ranked).toBe(41);
    expect(auditOf("project.unmerge")).toHaveLength(1);
  });

  it("dismissDuplicate resolves the pair as not_duplicates", () => {
    dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
    const dup = decisions(h.db, eventOf()).find(isDuplicate)!;
    expect(dup.resolved).toBe("not_duplicates");
    expect(auditOf("project.not_duplicate")).toHaveLength(1);
  });

  it("known-bad: dismissing a duplicate without a reason is 422 and writes nothing", () => {
    const before = auditRows().length;
    expectHttpError(() => dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "" }), 422, "invalid");
    expect(decisions(h.db, eventOf()).find(isDuplicate)!.resolved).toBeNull();
    expect(auditRows().length).toBe(before);
  });
});

describe("the submissions list follows the duplicate decision", () => {
  const rowsOf = () => Object.fromEntries(getSubmissions(organizer(), "evt_01").rows.filter((r) => ["prj_07", "prj_41"].includes(r.id)).map((r) => [r.id, { suspected: r.suspectedDuplicate, of: r.duplicateOf, mergedIn: r.mergedIn }]));

  it("flags both copies while the decision is open, and neither once it is made", () => {
    expect(rowsOf()).toEqual({ prj_07: { suspected: true, of: null, mergedIn: [] }, prj_41: { suspected: true, of: null, mergedIn: [] } });

    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    expect(rowsOf()).toEqual({ prj_07: { suspected: false, of: null, mergedIn: ["prj_41"] }, prj_41: { suspected: false, of: "prj_07", mergedIn: [] } });

    unmergeDuplicate(organizer(), "evt_01", { duplicateId: "prj_41" });
    dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
    expect(rowsOf()).toEqual({ prj_07: { suspected: false, of: null, mergedIn: [] }, prj_41: { suspected: false, of: null, mergedIn: [] } });
  });
});

describe("undoing a duplicate or under-reviewed decision", () => {
  const judge = () => actorById("jdg_01");

  it("undoing 'different projects' reopens the duplicate decision and writes one audit row", () => {
    dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
    undoNotDuplicate(organizer(), "evt_01", { ids: ["prj_41", "prj_07"] });
    expect(decisions(h.db, eventOf()).find(isDuplicate)!.resolved).toBeNull();
    expect(auditOf("project.not_duplicate_undo")).toHaveLength(1);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("undoing 'publish it as it is' reopens the under-reviewed decision and writes one audit row", () => {
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    undoAcceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19" });
    expect(decisions(h.db, eventOf()).find(isUnder)!.resolved).toBeNull();
    expect(auditOf("project.accept_under_reviewed_undo")).toHaveLength(1);
  });

  it("an undo with nothing to undo changes nothing and writes no row", () => {
    const before = auditRows().length;
    undoNotDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"] });
    undoAcceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19" });
    expect(auditRows().length).toBe(before);
  });

  it("known-bad: a judge cannot undo either decision — 403, both stay decided", () => {
    dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    expectHttpError(() => undoNotDuplicate(judge(), "evt_01", { ids: ["prj_07", "prj_41"] }), 403, "not_an_organizer");
    expectHttpError(() => undoAcceptUnderReviewed(judge(), "evt_01", { projectId: "prj_19" }), 403, "not_an_organizer");
    expect(decisions(h.db, eventOf()).find(isDuplicate)!.resolved).toBe("not_duplicates");
    expect(decisions(h.db, eventOf()).find(isUnder)!.resolved).toBe("accepted");
    expect(auditOf("project.not_duplicate_undo")).toHaveLength(0);
    expect(auditOf("project.accept_under_reviewed_undo")).toHaveLength(0);
  });

  it("known-bad: once published, no decision can be undone — 409 results_published", () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    publishResults(organizer(), "evt_01");
    expectHttpError(() => undoNotDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"] }), 409, "results_published");
    expectHttpError(() => undoAcceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19" }), 409, "results_published");
    expectHttpError(() => unmergeDuplicate(organizer(), "evt_01", { duplicateId: "prj_41" }), 409, "results_published");
  });
});

describe("acceptUnderReviewed and publishResults", () => {
  it("accepting the under-reviewed project resolves its decision", () => {
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    const under = decisions(h.db, eventOf()).find(isUnder)!;
    expect(under.projectId).toBe("prj_19");
    expect(under.resolved).toBe("accepted");
  });

  it("known-bad: publishing with open decisions is 409 decisions_open and leaves no run and no timestamp", () => {
    expect(getPublishedResults("evt_01")).toEqual({ published: false });
    expectHttpError(() => publishResults(organizer(), "evt_01"), 409, "decisions_open");
    expect(eventRow().resultsPublishedAt).toBeNull();
    expect(count("SELECT count(*) AS n FROM normalization_runs")).toBe(0);
  });

  it("publishes once every decision is settled: stores the run, locks the results, ranks each track", () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    expect(decisions(h.db, eventOf()).every((d) => d.resolved !== null)).toBe(true);

    const publishesBefore = auditOf("results.publish").length;
    const { runId } = publishResults(organizer(), "evt_01");
    expect(runId).toMatch(/^nrm_/);

    const row = eventRow();
    expect(row.resultsPublishedAt).toBeTypeOf("string");
    expect(JSON.parse(row.settings).publishedRunId).toBe(runId);

    expect(count("SELECT count(*) AS n FROM normalization_runs")).toBe(1);
    const run = h.sqlite.prepare("SELECT method, params FROM normalization_runs WHERE id = ?").get(runId) as {
      method: string;
      params: string;
    };
    expect(run.method).toBe(METHOD);
    expect(run.method).toBe("leniency-shrunk-v1");
    const params = JSON.parse(run.params) as Record<string, unknown>;
    expect(params).toHaveProperty("k");
    expect(params.excluded).toEqual(["jdg_07"]);
    expect(params.merges).toContainEqual({ duplicate: "prj_41", into: "prj_07" });
    expect(params.ranked).toBe(40);

    expect(nOf("SELECT count(*) AS n FROM normalized_scores WHERE run_id = ?", runId)).toBe(40);
    expect(auditOf("results.publish")).toHaveLength(publishesBefore + 1);
    expect(verifyAuditChain(h.db).ok).toBe(true);

    const published = getPublishedResults("evt_01");
    if (!published.published) throw new Error("results should be published");
    expect(published.runId).toBe(runId);
    expect(published.tracks).toHaveLength(8);
    expect(published.tracks.flatMap((t) => t.rows)).toHaveLength(40);
    for (const track of published.tracks) {
      for (let i = 1; i < track.rows.length; i++) {
        expect(track.rows[i]!.score).not.toBeNull();
        expect(track.rows[i]!.score!).toBeLessThanOrEqual(track.rows[i - 1]!.score!);
      }
      // average ranks: t projects tied at the top share place (1 + t) / 2
      const top = track.rows.filter((r) => Math.abs(r.score! - track.rows[0]!.score!) <= 1e-9).length;
      expect(track.rows[0]!.place).toBe((1 + top) / 2);
    }

    // published results are final
    expectHttpError(() => publishResults(organizer(), "evt_01"), 409, "results_published");
    expectHttpError(
      () => setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "include", reason: "Too late now" }),
      409,
      "results_published",
    );
  });

  it("known-bad: publishing while submissions are open is 409 submissions_open, after the 403 for a participant; after the close it goes through", () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    const closeAt = (h.sqlite.prepare("SELECT submissions_close_at AS c FROM events WHERE id = 'evt_01'").get() as { c: string }).c;
    const setClose = (iso: string) => h.sqlite.prepare("UPDATE events SET submissions_close_at = ? WHERE id = 'evt_01'").run(iso);
    setClose(new Date(Date.now() + 86_400_000).toISOString());

    const participant = addUser("usr_early", "early@example.org", "Early");
    expectHttpError(() => publishResults(participant, "evt_01"), 403, "not_an_organizer");
    const err = expectHttpError(() => publishResults(organizer(), "evt_01"), 409, "submissions_open");
    expect(err.message).toMatch(/^Submissions are open until .+\. Results can be published once they close\.$/);
    expect(eventRow().resultsPublishedAt).toBeNull();
    expect(count("SELECT count(*) AS n FROM normalization_runs")).toBe(0);
    expect(auditOf("results.publish")).toHaveLength(0);

    setClose(closeAt); // positive control: the same event, closed again, publishes
    expect(publishResults(organizer(), "evt_01").runId).toMatch(/^nrm_/);
  });

  it("known-bad: a participant cannot publish — 403, nothing published", () => {
    const participant = addUser("usr_sneaky", "sneaky@example.org", "Sneaky");
    expectHttpError(() => publishResults(participant, "evt_01"), 403, "not_an_organizer");
    expect(eventRow().resultsPublishedAt).toBeNull();
    expect(count("SELECT count(*) AS n FROM normalization_runs")).toBe(0);
    expect(count("SELECT count(*) AS n FROM normalized_scores")).toBe(0);
  });
});

describe("publishing ends the community vote", () => {
  const CLIENT = { ip: "10.9.0.1", agent: "Browser" };
  const settle = () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  };
  // Open-link ballots count here, so a link voter stands in for any voter; that they are
  // counted apart by default is tested in voting-open-link.test.ts.
  const setWindow = (votingOpenAt: string, votingCloseAt: string) =>
    saveVotingSettings(organizer(), "evt_01", { votingOpenAt, votingCloseAt, modes: ["link"], votesPerVoter: "3", countLink: true });
  const lastPublish = () => auditOf("results.publish").at(-1)!.after as { voteEnded?: string };

  it("an open vote closes at the publishing moment: no ballot after it, the count public and final, the log says so", () => {
    setWindow("2026-01-01T00:00", "2999-01-01T00:00");
    const { token } = enterVoting(makeVotingLink(organizer(), "evt_01").code, CLIENT);
    castBallot(null, "evt_01", token, { projectIds: ["prj_02"] }, CLIENT);
    expect(getCommunityResults("evt_01").tally).toBeNull();
    settle();
    publishResults(organizer(), "evt_01");

    const event = eventOf();
    expect(event.votingCloseAt).toBe(event.resultsPublishedAt);
    const community = getCommunityResults("evt_01");
    expect(community.state).toBe("closed");
    expect(community.tally!.find((t) => t.projectId === "prj_02")?.votes).toBe(1);
    expectHttpError(() => castBallot(null, "evt_01", token, { projectIds: ["prj_03"] }, CLIENT), 403, "voting_closed");
    expectHttpError(() => setWindow("2026-01-01T00:00", "2999-01-01T00:00"), 409, "voting_closed");
    expect(lastPublish().voteEnded).toBe("open");
    const line = getAuditLog(organizer(), "evt_01").lines.find((l) => l.action === "results.publish")!;
    expect(line.parts.map((p) => p.text).join("")).toMatch(/published the results and closed the community vote$/);
    expect(verifyAuditChain(h.db).ok).toBe(true);
  });

  it("a vote that has not opened is called off, and none can be set up after publishing (known-bad control: before publishing it can)", () => {
    setWindow("2998-01-01T00:00", "2999-01-01T00:00");
    setWindow("2998-01-01T00:00", "2999-06-01T00:00"); // before publishing the window can still move
    settle();
    publishResults(organizer(), "evt_01");
    const event = eventOf();
    expect([event.votingOpenAt, event.votingCloseAt]).toEqual([null, null]);
    expect(getCommunityResults("evt_01").state).toBe("not_set");
    expectHttpError(() => setWindow("2026-01-01T00:00", "2999-01-01T00:00"), 409, "results_published");
    expectHttpError(() => makeVotingLink(organizer(), "evt_01"), 409, "results_published");
    expect(lastPublish().voteEnded).toBe("upcoming");
  });

  it("with no vote set up, publishing leaves the window unset and says nothing about a vote", () => {
    settle();
    publishResults(organizer(), "evt_01");
    expect(eventOf().votingOpenAt).toBeNull();
    expect(lastPublish().voteEnded).toBeUndefined();
    expectHttpError(() => setWindow("2026-01-01T00:00", "2999-01-01T00:00"), 409, "results_published");
  });
});

describe("normalized.csv after publishing is the published run", () => {
  const settle = () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  };
  const csv = () => exportFile(organizer(), "evt_01", "normalized.csv").body;

  it("read back from the stored run, it is the file the engine gave at the moment of publishing, byte for byte", () => {
    settle();
    const live = csv();
    publishResults(organizer(), "evt_01");
    expect(csv()).toBe(live);
    // the merged copy keeps its own row, as the live file had it
    expect(live).toContain("prj_41,");
  });

  it("known-bad: a change after publishing that moves the live engine does not move the file", () => {
    settle();
    const { runId } = publishResults(organizer(), "evt_01");
    const published = csv();
    // a finished review taken out of the engine after publishing (assignments carry no publish trigger)
    const a = h.sqlite
      .prepare("SELECT a.id AS id, a.project_id AS project FROM assignments a WHERE a.event_id = 'evt_01' AND a.status = 'done' AND a.judge_user_id <> 'jdg_07' AND a.project_id NOT IN ('prj_07', 'prj_41') ORDER BY a.id LIMIT 1")
      .get() as { id: string; project: string };
    h.sqlite.prepare("UPDATE assignments SET status = 'recused' WHERE id = ?").run(a.id);
    // the instrument sees the move: the engine, worked out now, counts one review fewer for that project
    const storedN = (h.sqlite.prepare("SELECT n FROM normalized_scores WHERE run_id = ? AND project_id = ?").get(runId, a.project) as { n: number }).n;
    expect(computeNormalization(h.db, eventOf()).projects.find((p) => p.id === a.project)!.n).toBe(storedN - 1);
    expect(csv()).toBe(published);
  });

  it("a run stored before the run kept its whole table still exports, with the columns it lacks left empty", () => {
    settle();
    const { runId } = publishResults(organizer(), "evt_01");
    const full = csv();
    // the same run without the table, as runs published before it were stored (published runs are write-once, so rebuild the row)
    const params = JSON.parse((h.sqlite.prepare("SELECT params FROM normalization_runs WHERE id = ?").get(runId) as { params: string }).params);
    delete params.table;
    const triggers = h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'normalization_runs'").all() as { name: string }[];
    for (const t of triggers) h.sqlite.exec(`DROP TRIGGER "${t.name}"`);
    h.sqlite.prepare("UPDATE normalization_runs SET params = ? WHERE id = ?").run(JSON.stringify(params), runId);
    const old = csv();
    const [head, ...rows] = old.trim().split(/\r?\n/);
    expect(head).toBe(full.trim().split(/\r?\n/)[0]);
    expect(rows.length).toBe(full.trim().split(/\r?\n/).length - 1);
    // the stored numbers are the same: each project's normalized score and rank, read from the end of the line
    // (a title may hold a quoted comma), line up with the full file
    const pick = (text: string) =>
      new Map(text.trim().split(/\r?\n/).slice(1).map((l) => [l.split(",")[0], `${l.split(",").at(-11)}|${l.split(",").at(-7)}`]));
    expect(pick(old)).toEqual(pick(full));
    expect([...pick(full).values()].filter((v) => v !== "|").length).toBeGreaterThan(30);
  });
});

describe("normalized.csv before anything is measured", () => {
  it("leaves beta2 and sigma2 empty while no project has two counted reviews; the fixture's measured run fills them", () => {
    const rows = () =>
      exportFile(organizer(), "evt_01", "normalized.csv")
        .body.trim()
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.split(","));
    // the last columns are k, beta2, sigma2, excluded_judges; read from the end so a quoted comma cannot shift them
    const variance = (r: string[]) => ({ beta2: r.at(-3), sigma2: r.at(-2) });

    // positive control: the fixture has projects reviewed several times, so both are measured
    expect(variance(rows()[0]!).sigma2).toMatch(/^\d+\.\d{4}$/);

    h.sqlite.exec("DELETE FROM score_items; DELETE FROM score_comments; DELETE FROM scores;");
    const after = rows();
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => variance(r).beta2 === "" && variance(r).sigma2 === "")).toBe(true);
  });
});

describe("decisions name only this event's projects", () => {
  it("known-bad: 'different projects' and 'publish as it is' refuse an id from nowhere (422) and store nothing; real ids still work", () => {
    const settingsNow = () => (h.sqlite.prepare("SELECT settings FROM events WHERE id = 'evt_01'").get() as { settings: string }).settings;
    const before = settingsNow();
    expectHttpError(() => dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_nowhere"], reason: "Checked by hand" }), 422, "invalid");
    expectHttpError(() => acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_nowhere", reason: "Checked by hand" }), 422, "invalid");
    expect(settingsNow()).toBe(before);

    // positive controls: the event's own projects are accepted
    dismissDuplicate(organizer(), "evt_01", { ids: ["prj_07", "prj_41"], reason: "Checked by hand" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    expect(settingsNow()).not.toBe(before);
  });
});
