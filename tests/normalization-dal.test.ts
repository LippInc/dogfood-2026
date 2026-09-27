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
import {
  METHOD,
  acceptUnderReviewed,
  computeNormalization,
  decisions,
  dismissDuplicate,
  getNormalization,
  getPublishedResults,
  mergeDuplicate,
  publishResults,
  revokeJudgeOverride,
  setJudgeOverride,
  undoAcceptUnderReviewed,
  undoNotDuplicate,
  unmergeDuplicate,
  type Decision,
} from "@/server/dal/normalization";
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

  it("known-bad: a participant cannot publish — 403, nothing published", () => {
    const participant = addUser("usr_sneaky", "sneaky@example.org", "Sneaky");
    expectHttpError(() => publishResults(participant, "evt_01"), 403, "not_an_organizer");
    expect(eventRow().resultsPublishedAt).toBeNull();
    expect(count("SELECT count(*) AS n FROM normalization_runs")).toBe(0);
    expect(count("SELECT count(*) AS n FROM normalized_scores")).toBe(0);
  });
});
