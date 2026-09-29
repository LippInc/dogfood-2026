import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";

// Once an event's results are published, the database refuses a row added to any table the published ranking rests
// on, and an edit or removal of the assignments, the rubric, the judge overrides and a project's track or merge
// (src/server/db/triggers.ts, drizzle/0017_published_inserts.sql). Each refusal has its positive control: the same
// kind of row goes in before publishing. The records, the boot import and the publish step itself are covered by
// records.test.ts and audit.test.ts, which run on these triggers.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
});

afterEach(() => {
  h.sqlite.close();
});

const run = (sql: string, ...params: (string | number)[]) => h.sqlite.prepare(sql).run(...params);
const refused = (sql: string, pattern: RegExp, ...params: (string | number)[]) => expect(() => run(sql, ...params)).toThrow(pattern);
const publish = () => run("UPDATE events SET results_published_at = ? WHERE id = 'evt_01'", NOW);
const count = (table: string) => (h.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
const ADD = /the results are published, so nothing can be added/;
const FINAL = /the results are published, so this is final/;

/** judge and project pairs of evt_01 that have no assignment yet, and the run the fixture's assignments belong to */
function freePairs(n: number) {
  const pairs = h.sqlite
    .prepare(
      `SELECT r.user_id AS judge, p.id AS project FROM user_roles r JOIN projects p ON p.event_id = r.event_id
       WHERE r.event_id = 'evt_01' AND r.role = 'judge'
         AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.judge_user_id = r.user_id AND a.project_id = p.id)
       ORDER BY r.user_id, p.id LIMIT ?`,
    )
    .all(n) as { judge: string; project: string }[];
  expect(pairs).toHaveLength(n);
  const runId = (h.sqlite.prepare("SELECT run_id AS r FROM assignments WHERE event_id = 'evt_01' LIMIT 1").get() as { r: string }).r;
  return { pairs, runId };
}
const addAssignment = (id: string, p: { judge: string; project: string }, runId: string) =>
  run("INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, created_at) VALUES (?, 'evt_01', ?, ?, ?, ?)", id, p.judge, p.project, runId, NOW);
const criteria = () => (h.sqlite.prepare("SELECT id FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position").all() as { id: string }[]).map((r) => r.id);

describe("after publishing, the database refuses additions to what the ranking rests on", () => {
  it("reviews: an assignment, a score, a value and feedback go in before publishing; none goes in after", () => {
    const { pairs, runId } = freePairs(4);
    const [c1, c2] = criteria();
    addAssignment("asg_t1", pairs[0]!, runId);
    addAssignment("asg_t2", pairs[1]!, runId);
    addAssignment("asg_t3", pairs[2]!, runId);
    run("INSERT INTO scores (id, assignment_id, updated_at) VALUES ('scr_t1', 'asg_t1', ?)", NOW);
    run("INSERT INTO scores (id, assignment_id, updated_at) VALUES ('scr_t1b', 'asg_t2', ?)", NOW);
    run("INSERT INTO score_items (score_id, criterion_id, value) VALUES ('scr_t1', ?, 3)", c1!);
    run("INSERT INTO score_comments (score_id, feedback) VALUES ('scr_t1', 'before')");

    publish();
    refused("INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, created_at) VALUES ('asg_t4', 'evt_01', ?, ?, ?, ?)", ADD, pairs[3]!.judge, pairs[3]!.project, runId, NOW);
    refused("INSERT INTO scores (id, assignment_id, updated_at) VALUES ('scr_t3', 'asg_t3', ?)", ADD, NOW);
    refused("INSERT INTO score_items (score_id, criterion_id, value) VALUES ('scr_t1', ?, 3)", ADD, c2!);
    refused("INSERT INTO score_comments (score_id, feedback) VALUES ('scr_t1b', 'after')", ADD);
  });

  it("assignments: status changes and removals go through before publishing, and are refused after", () => {
    const { pairs, runId } = freePairs(2);
    addAssignment("asg_t1", pairs[0]!, runId);
    addAssignment("asg_t2", pairs[1]!, runId);
    run("UPDATE assignments SET status = 'recused' WHERE id = 'asg_t1'");
    run("DELETE FROM assignments WHERE id = 'asg_t1'");
    publish();
    refused("UPDATE assignments SET status = 'recused' WHERE id = 'asg_t2'", FINAL);
    refused("DELETE FROM assignments WHERE id = 'asg_t2'", FINAL);
  });

  it("the rubric: a criterion is added, re-weighted and removed before publishing; after, each is refused", () => {
    run("INSERT INTO rubric_criteria (id, event_id, key, label) VALUES ('crit_t1', 'evt_01', 't1', 'T1')");
    run("INSERT INTO rubric_criteria (id, event_id, key, label) VALUES ('crit_t0', 'evt_01', 't0', 'T0')");
    run("UPDATE rubric_criteria SET weight = 2 WHERE id = 'crit_t1'");
    run("DELETE FROM rubric_criteria WHERE id = 'crit_t0'");
    publish();
    refused("INSERT INTO rubric_criteria (id, event_id, key, label) VALUES ('crit_t2', 'evt_01', 't2', 'T2')", ADD);
    refused("UPDATE rubric_criteria SET weight = 3 WHERE id = 'crit_t1'", FINAL);
    refused("DELETE FROM rubric_criteria WHERE id = 'crit_t1'", FINAL);
  });

  it("judge overrides: set, revoked and removed before publishing; after, none of the three", () => {
    const judge = (h.sqlite.prepare("SELECT user_id AS u FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' LIMIT 1").get() as { u: string }).u;
    const add = (id: string) =>
      run("INSERT INTO judge_overrides (id, event_id, judge_user_id, mode, reason, created_at, created_by) VALUES (?, 'evt_01', ?, 'exclude', 'a test reason', ?, ?)", id, judge, NOW, judge);
    add("jov_t0");
    add("jov_t1");
    run("UPDATE judge_overrides SET revoked_at = ?, revoked_by = ? WHERE id = 'jov_t0'", NOW, judge);
    run("DELETE FROM judge_overrides WHERE id = 'jov_t0'");
    publish();
    expect(() => add("jov_t2")).toThrow(ADD);
    refused("UPDATE judge_overrides SET revoked_at = ?, revoked_by = ? WHERE id = 'jov_t1'", FINAL, NOW, judge);
    refused("DELETE FROM judge_overrides WHERE id = 'jov_t1'", FINAL);
  });

  it("pairwise answers: one goes in before publishing, the same question answered again after is refused", () => {
    const answer = (id: string) =>
      run("INSERT INTO comparisons (id, event_id, judge_user_id, track_id, left_project_id, right_project_id, new_project_id, outcome, created_at) VALUES (?, 'evt_01', 'jdg_01', 'trk_01', 'prj_01', 'prj_02', 'prj_02', 'left', ?)", id, NOW);
    answer("cmp_t1");
    run("UPDATE comparisons SET voided_at = ? WHERE id = 'cmp_t1'", NOW);
    publish();
    expect(() => answer("cmp_t2")).toThrow(ADD);
  });

  it("stored runs: a run and its rows go in before publishing; after, neither a new run nor a row in a stored one", () => {
    run("INSERT INTO normalization_runs (id, event_id, method, params, computed_at) VALUES ('nrm_t1', 'evt_01', 'leniency-shrunk-v1', '{}', ?)", NOW);
    run("INSERT INTO normalized_scores (run_id, project_id, n, raw_mean, normalized_mean) VALUES ('nrm_t1', 'prj_01', 3, 3.5, 3.6)");
    publish();
    refused("INSERT INTO normalization_runs (id, event_id, method, params, computed_at) VALUES ('nrm_t2', 'evt_01', 'leniency-shrunk-v1', '{}', ?)", ADD, NOW);
    refused("INSERT INTO normalized_scores (run_id, project_id, n, raw_mean, normalized_mean) VALUES ('nrm_t1', 'prj_02', 3, 3.5, 3.6)", ADD);
  });

  it("a project's track and merge are final after publishing; its title still changes, and before publishing all three do", () => {
    const [a, b] = (h.sqlite.prepare("SELECT id, track_id AS t FROM projects WHERE event_id = 'evt_01' ORDER BY id LIMIT 2").all() as { id: string; t: string }[]);
    const other = (h.sqlite.prepare("SELECT id FROM tracks WHERE event_id = 'evt_01' AND id <> ? LIMIT 1").get(a!.t) as { id: string }).id;
    run("UPDATE projects SET track_id = ? WHERE id = ?", other, a!.id);
    run("UPDATE projects SET track_id = ? WHERE id = ?", a!.t, a!.id);
    run("UPDATE projects SET duplicate_of = ? WHERE id = ?", b!.id, a!.id);
    run("UPDATE projects SET duplicate_of = NULL WHERE id = ?", a!.id);
    publish();
    refused("UPDATE projects SET track_id = ? WHERE id = ?", /track and merges are final/, other, a!.id);
    refused("UPDATE projects SET duplicate_of = ? WHERE id = ?", /track and merges are final/, b!.id, a!.id);
    run("UPDATE projects SET title = 'Renamed after publishing' WHERE id = ?", a!.id);
  });

  it("another event stays open: the freeze is per event", () => {
    const before = count("rubric_criteria");
    run("INSERT INTO events (id, slug, name, submissions_close_at, created_at) VALUES ('evt_t', 'evt-t', 'Other', ?, ?)", NOW, NOW);
    publish();
    run("INSERT INTO rubric_criteria (id, event_id, key, label) VALUES ('crit_o', 'evt_t', 'o', 'O')");
    expect(count("rubric_criteria")).toBe(before + 1);
  });
});
