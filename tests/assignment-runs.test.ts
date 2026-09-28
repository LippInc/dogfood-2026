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
import { assignByHand, getAssignments, runAssignment } from "@/server/dal/assignments";
import { judgeSet } from "@/server/dal/judging";
import { acceptUnderReviewed, dismissDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { publishResults } from "@/server/dal/results";
import type { Actor } from "@/server/authz";

const NOW = "2026-09-26T12:00:00.000Z";

let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h); // the assignment DAL goes through getDb()
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
const auditRows = () => h.db.select().from(auditLog).orderBy(auditLog.id).all();

function actorOn(handle: Handle, userId: string): Actor {
  const u = handle.sqlite.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId) as
    | { id: string; name: string; email: string }
    | undefined;
  if (!u) throw new Error(`no user row for ${userId}`);
  const roles = handle.db
    .select({ eventId: userRoles.eventId, role: userRoles.role })
    .from(userRoles)
    .where(eq(userRoles.userId, userId))
    .all();
  return { userId: u.id, name: u.name, email: u.email, isAdmin: false, roles, sessionKind: "login" };
}
const actorById = (userId: string) => actorOn(h, userId);

function addUser(id: string, email: string, name: string): Actor {
  h.sqlite
    .prepare("INSERT INTO users (id, email, name, password_hash, is_admin, created_at) VALUES (?, ?, ?, NULL, 0, ?)")
    .run(id, email, name, NOW);
  return actorById(id);
}

/** Drop every judging artefact, children first, keeping users, roles, tracks and projects. */
function wipeJudging(handle: Handle = h) {
  for (const statement of [
    "DELETE FROM score_items;",
    "DELETE FROM score_comments;",
    "DELETE FROM scores;",
    "DELETE FROM assignments;",
    "DELETE FROM assignment_runs;",
  ]) {
    handle.sqlite.exec(statement);
  }
}

type Pair = { judge_user_id: string; project_id: string; batch_no: number; position: number; status: string };
const pairsOfRun = (runId: string) =>
  h.sqlite.prepare("SELECT judge_user_id, project_id, batch_no, position, status FROM assignments WHERE run_id = ?").all(runId) as unknown as Pair[];
const runRow = (runId: string) =>
  h.sqlite.prepare("SELECT id, mode, seed, params FROM assignment_runs WHERE id = ?").get(runId) as {
    id: string;
    mode: string;
    seed: number;
    params: string;
  };
const runCount = () => count("SELECT count(*) AS n FROM assignment_runs");
const assignCount = () => count("SELECT count(*) AS n FROM assignments");

describe("runAssignment", () => {
  it("refuses a fresh run on the imported fixture with 409 assignments_exist", () => {
    expect(assignCount()).toBeGreaterThan(0); // the fixture's own pairs are there
    expectHttpError(() => runAssignment(actorById("usr_organizer"), "evt_01", { mode: "fresh" }), 409, "assignments_exist");
    expect(runCount()).toBe(1); // only run_fixture_evt_01
  });

  it("known-bad: no session → 401 and no run row added", () => {
    const runs = runCount();
    const before = auditRows().length;
    expectHttpError(() => runAssignment(null, "evt_01", { mode: "topup" }), 401, "unauthenticated");
    expect(runCount()).toBe(runs);
    expect(auditRows().length).toBe(before);
  });

  it("top-up on the fixture: pending in-track pairs after each judge's old ones, flat judge out, one audit row", () => {
    const out = runAssignment(actorById("usr_organizer"), "evt_01", { mode: "topup", seed: 42 });

    expect(out.mode).toBe("topup");
    expect(out.seed).toBe(42);
    expect(out.added).toBeGreaterThan(0);

    const rows = pairsOfRun(out.runId);
    expect(rows).toHaveLength(out.added); // `added` counts exactly the new assignment rows
    expect(rows.every((r) => r.status === "pending")).toBe(true);

    const run = runRow(out.runId);
    expect(run.mode).toBe("topup");
    expect(run.seed).toBe(42);
    expect(JSON.parse(run.params).reviewsPerProject).toBe(3);

    // every new pair is in the judge's tracks
    const outOfTrack = h.sqlite
      .prepare(
        `SELECT count(*) AS n FROM assignments a
         JOIN projects p ON p.id = a.project_id
         WHERE a.run_id = ? AND NOT EXISTS (
           SELECT 1 FROM judge_tracks jt
           WHERE jt.judge_user_id = a.judge_user_id AND jt.event_id = 'evt_01' AND jt.track_id = p.track_id
         )`,
      )
      .get(out.runId) as { n: number };
    expect(outOfTrack.n).toBe(0);

    // jdg_07 is the flat judge: excluded from new pairs entirely
    expect(rows.filter((r) => r.judge_user_id === "jdg_07")).toHaveLength(0);

    // batches and positions continue after each judge's previous maximum
    const judges = [...new Set(rows.map((r) => r.judge_user_id))];
    for (const judgeId of judges) {
      const prev = h.sqlite
        .prepare("SELECT max(batch_no) AS b, max(position) AS p FROM assignments WHERE event_id = 'evt_01' AND judge_user_id = ? AND run_id != ?")
        .get(judgeId, out.runId) as { b: number | null; p: number | null };
      const prevBatch = prev.b ?? 0;
      const prevPosition = prev.p ?? -1;
      const mine = rows.filter((r) => r.judge_user_id === judgeId);
      expect(mine.every((r) => r.batch_no === prevBatch + 1), `batch_no for ${judgeId}`).toBe(true);
      expect(mine.every((r) => r.position > prevPosition), `positions for ${judgeId}`).toBe(true);
    }

    expect(auditRows().filter((r) => r.action === "assignment.run")).toHaveLength(1);
  });

  it("a second top-up right after adds nothing and still stores a run row", () => {
    runAssignment(actorById("usr_organizer"), "evt_01", { mode: "topup", seed: 42 });
    const pairs = assignCount();
    const runs = runCount();

    const out = runAssignment(actorById("usr_organizer"), "evt_01", { mode: "topup", seed: 123 });

    expect(out.added).toBe(0);
    expect(assignCount()).toBe(pairs);
    expect(runCount()).toBe(runs + 1); // the run row is still stored
    expect(JSON.parse(runRow(out.runId).params).added).toBe(0);
  });

  it("determinism: the same wiped state and seed give identical pairs in two separate databases", () => {
    wipeJudging();
    const first = runAssignment(actorById("usr_organizer"), "evt_01", { mode: "fresh", seed: 7 });
    const setA = (
      h.sqlite.prepare("SELECT judge_user_id, project_id, position FROM assignments WHERE run_id = ?").all(first.runId) as unknown as {
        judge_user_id: string;
        project_id: string;
        position: number;
      }[]
    ).map((r) => `${r.judge_user_id}|${r.project_id}|${r.position}`);

    const h2 = openDatabase(":memory:");
    runMigrations(h2, path.join(process.cwd(), "drizzle"));
    const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
    importFixtures(h2.db, fixture, { source: "fixtures.json", sha256, now: NOW });
    ensureDemoOrganizer(h2.db, "evt_01", NOW);
    wipeJudging(h2);
    setHandleForTests(h2);
    try {
      const second = runAssignment(actorOn(h2, "usr_organizer"), "evt_01", { mode: "fresh", seed: 7 });
      const setB = (
        h2.sqlite.prepare("SELECT judge_user_id, project_id, position FROM assignments WHERE run_id = ?").all(second.runId) as unknown as {
          judge_user_id: string;
          project_id: string;
          position: number;
        }[]
      ).map((r) => `${r.judge_user_id}|${r.project_id}|${r.position}`);
      expect(setB).toHaveLength(setA.length);
      expect([...setB].sort()).toEqual([...setA].sort());
    } finally {
      setHandleForTests(h);
      h2.sqlite.close();
    }
  });

  it("fresh on the wiped fixture: two-track judges cover both tracks, every submitted project reaches min(3, eligible)", () => {
    wipeJudging();
    const out = runAssignment(actorById("usr_organizer"), "evt_01", { mode: "fresh", seed: 42 });
    const rows = pairsOfRun(out.runId);

    // the fixture gives exactly these judges two tracks
    const twoTrack: Record<string, string[]> = {
      jdg_02: ["trk_02", "trk_04"],
      jdg_03: ["trk_04", "trk_05"],
      jdg_11: ["trk_05", "trk_07"],
      jdg_12: ["trk_03", "trk_07"],
      jdg_20: ["trk_04", "trk_08"],
      jdg_23: ["trk_04", "trk_06"],
      jdg_24: ["trk_01", "trk_07"],
      jdg_26: ["trk_01", "trk_03"],
      jdg_29: ["trk_06", "trk_08"],
    };
    const actualTwoTrack = (
      h.sqlite
        .prepare("SELECT judge_user_id AS j FROM judge_tracks WHERE event_id = 'evt_01' GROUP BY judge_user_id HAVING count(*) = 2")
        .all() as unknown as { j: string }[]
    ).map((r) => r.j);
    expect(new Set(actualTwoTrack)).toEqual(new Set(Object.keys(twoTrack)));

    const trackOf = new Map(
      (
        h.sqlite.prepare("SELECT id, track_id FROM projects WHERE event_id = 'evt_01'").all() as unknown as {
          id: string;
          track_id: string;
        }[]
      ).map((r) => [r.id, r.track_id]),
    );
    for (const [judgeId, trackIds] of Object.entries(twoTrack)) {
      for (const trackId of trackIds) {
        const n = rows.filter((r) => r.judge_user_id === judgeId && trackOf.get(r.project_id) === trackId).length;
        expect(n, `${judgeId} in ${trackId}`).toBeGreaterThanOrEqual(2);
      }
    }

    // coverage: with no scores left, nobody is flat-excluded; eligibility is tracks minus the project's own team
    const excluded = new Set(judgeSet(h.db, "evt_01").excluded);
    expect(excluded.size).toBe(0);
    const judgesByTrack = new Map<string, string[]>();
    for (const r of h.sqlite
      .prepare("SELECT judge_user_id AS j, track_id AS t FROM judge_tracks WHERE event_id = 'evt_01'")
      .all() as unknown as { j: string; t: string }[]) {
      judgesByTrack.set(r.t, [...(judgesByTrack.get(r.t) ?? []), r.j]);
    }
    const projects = h.sqlite
      .prepare("SELECT id, track_id, team_id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' AND duplicate_of IS NULL")
      .all() as unknown as { id: string; track_id: string; team_id: string }[];
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      const teamJudges = new Set(
        (h.sqlite.prepare("SELECT user_id FROM team_members WHERE team_id = ?").all(p.team_id) as unknown as { user_id: string }[]).map(
          (r) => r.user_id,
        ),
      );
      const eligible = (judgesByTrack.get(p.track_id) ?? []).filter((j) => !excluded.has(j) && !teamJudges.has(j));
      const n = rows.filter((r) => r.project_id === p.id).length;
      expect(n, `coverage of ${p.id}`).toBeGreaterThanOrEqual(Math.min(3, eligible.length));
    }
  });
});

describe("assignByHand", () => {
  /** A judge who is in the event, does not cover prj_19's track, has no pair with it and is not on its team. */
  const judgeForPrj19 = () =>
    (
      h.sqlite
        .prepare(
          `SELECT u.id FROM users u
           JOIN user_roles ur ON ur.user_id = u.id AND ur.event_id = 'evt_01' AND ur.role = 'judge'
           WHERE u.id NOT IN (SELECT judge_user_id FROM judge_tracks WHERE event_id = 'evt_01'
                              AND track_id = (SELECT track_id FROM projects WHERE id = 'prj_19'))
             AND u.id NOT IN (SELECT judge_user_id FROM assignments WHERE project_id = 'prj_19')
             AND u.id NOT IN (SELECT user_id FROM team_members WHERE team_id = (SELECT team_id FROM projects WHERE id = 'prj_19'))
           ORDER BY u.id LIMIT 1`,
        )
        .get() as { id: string }
    ).id;

  it("refuses a hand assignment without a reason with 422", () => {
    expectHttpError(
      () => assignByHand(actorById("usr_organizer"), "evt_01", { projectId: "prj_19", judgeUserId: "jdg_01", reason: "" }),
      422,
      "invalid",
    );
  });

  it("assigns out-of-track by hand with an audited reason; the same pair again is 409; a non-judge is 422; a participant is 403", () => {
    const org = actorById("usr_organizer");
    const judgeUserId = judgeForPrj19();
    const before = auditRows().length;

    const out = assignByHand(org, "evt_01", { projectId: "prj_19", judgeUserId, reason: "only one judge left in this track" });

    const row = h.sqlite
      .prepare("SELECT status, run_id FROM assignments WHERE judge_user_id = ? AND project_id = 'prj_19'")
      .get(judgeUserId) as { status: string; run_id: string };
    expect(row.status).toBe("pending");
    expect(row.run_id).toBe(out.runId);
    const params = JSON.parse(runRow(out.runId).params) as { byHand?: boolean; inTrack?: boolean };
    expect(params.byHand).toBe(true);
    expect(params.inTrack).toBe(false);

    const byHand = auditRows().filter((r) => r.action === "assignment.by_hand");
    expect(byHand).toHaveLength(1);
    expect(byHand[0]!.targetId).toBe("prj_19");
    expect(JSON.stringify(byHand[0]!.after)).toContain("only one judge left in this track");
    expect(verifyAuditChain(h.db).ok).toBe(true);

    expectHttpError(
      () => assignByHand(org, "evt_01", { projectId: "prj_19", judgeUserId, reason: "same pair again" }),
      409,
      "already_assigned",
    );
    expect(count(`SELECT count(*) AS n FROM assignments WHERE judge_user_id = '${judgeUserId}' AND project_id = 'prj_19'`)).toBe(1);

    const plain = addUser("usr_hand_plain", "handplain@example.org", "Hand Plain");
    expectHttpError(
      () => assignByHand(org, "evt_01", { projectId: "prj_19", judgeUserId: plain.userId, reason: "not a judge here" }),
      422,
      "invalid",
    );

    expectHttpError(
      () => assignByHand(plain, "evt_01", { projectId: "prj_19", judgeUserId: "jdg_01", reason: "a participant cannot" }),
      403,
      "not_an_organizer",
    );
    expect(auditRows().length).toBe(before + 2); // the by_hand row and the participant's refusal; the 409/422 roll back
    expect(auditRows().filter((r) => r.action === "authz.refused")).toHaveLength(1);
    expect(runCount()).toBe(2); // the fixture run and the hand run, nothing else
  });
});

describe("after the results are published", () => {
  it("known-bad: neither a top-up nor a hand assignment — 409 results_published, no pair added", () => {
    const org = actorById("usr_organizer");
    setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    dismissDuplicate(org, "evt_01", { ids: ["prj_07", "prj_41"], reason: "Two different entries" });
    acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    publishResults(org, "evt_01");
    const pairs = () => (h.sqlite.prepare("SELECT count(*) AS n FROM assignments WHERE event_id = 'evt_01'").get() as { n: number }).n;
    const before = pairs();

    expectHttpError(() => runAssignment(org, "evt_01", { mode: "topup", seed: 42 }), 409, "results_published");
    expectHttpError(() => assignByHand(org, "evt_01", { projectId: "prj_19", judgeUserId: "jdg_01", reason: "Too late to help" }), 409, "results_published");
    expect(pairs()).toBe(before);
  });
});

describe("getAssignments", () => {
  it("shows the fixture run and that assignments exist", () => {
    const view = getAssignments(actorById("usr_organizer"), "evt_01");
    expect(view.runs.map((r) => r.id)).toContain("run_fixture_evt_01");
    expect(view.hasAssignments).toBe(true);
  });

  it("refuses a participant with 403", () => {
    const plain = addUser("usr_view_plain", "viewplain@example.org", "View Plain");
    expectHttpError(() => getAssignments(plain, "evt_01"), 403, "not_an_organizer");
  });
});
