import { describe, expect, it } from "vitest";
import { runAssignment } from "@/server/dal/assignments";
import { moveProjectTrack } from "@/server/dal/corrections";
import { setJudgeTracks } from "@/server/dal/judges";
import { finishedReviews } from "@/server/dal/judging";
import { getJudgeConsole, saveReview } from "@/server/dal/reviews";
import { latestAudit } from "@/server/dal/audit-log";
import { verifyAuditChain } from "@/server/audit";
import { getDb } from "@/server/db/client";
import { actorById, auditRows, count, expectHttpError, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Once judges are assigned a team can no longer change its project's track ("ask the
// organizer"), and before this no organizer action could. An organizer now moves it, with a
// reason; unstarted reviews by judges outside the new track are withdrawn, finished ones keep
// counting, started ones stay in the record, and a top-up brings judges from the new track.

withFixtureEvent();

type A = { id: string; judge: string; status: string; started: number };
const assignmentsOf = (project: string) =>
  sqlAll<A>(
    "SELECT a.id, a.judge_user_id AS judge, a.status, EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id) AS started FROM assignments a WHERE a.project_id = ? ORDER BY a.id",
    project,
  );
const trackOf = (project: string) => sqlGet<{ t: string }>("SELECT track_id AS t FROM projects WHERE id = ?", project)!.t;
const judgesIn = (track: string) => sqlAll<{ j: string }>("SELECT judge_user_id AS j FROM judge_tracks WHERE track_id = ? AND event_id = 'evt_01'", track).map((r) => r.j);
const hasTrack = (judge: string, track: string) => count("SELECT count(*) AS n FROM judge_tracks WHERE judge_user_id = ? AND track_id = ?", judge, track) > 0;

/** After a top-up: a project with finished reviews and at least two open, unstarted ones, and a track to move it to. */
function setUp() {
  runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
  const project = sqlGet<{ p: string }>(
    `SELECT a.project_id AS p FROM assignments a
      WHERE a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id)
        AND EXISTS (SELECT 1 FROM assignments d WHERE d.project_id = a.project_id AND d.status = 'done')
      GROUP BY a.project_id ORDER BY count(*) DESC, a.project_id LIMIT 1`,
  )!.p;
  const from = trackOf(project);
  const to = sqlGet<{ id: string }>("SELECT id FROM tracks WHERE event_id = 'evt_01' AND id != ? ORDER BY position LIMIT 1", from)!.id;
  return { project, from, to };
}

describe("moveProjectTrack", () => {
  it("moves the project: unstarted reviews outside the new track are withdrawn, finished ones keep counting, one audit row", () => {
    const { project, from, to } = setUp();
    const before = assignmentsOf(project);
    const counted = finishedReviews(getDb(), "evt_01").filter((r) => r.projectId === project).length;
    const withdrawn = before.filter((a) => a.status === "pending" && !a.started && !hasTrack(a.judge, to));
    const finished = before.filter((a) => a.status === "done" && !hasTrack(a.judge, to));
    expect(withdrawn.length).toBeGreaterThan(0);

    const out = moveProjectTrack(organizer(), "evt_01", project, { trackId: to, reason: "The team entered the wrong track" });
    expect(out).toEqual({ moved: true, trackId: to, withdrawn: withdrawn.length, finishedKept: finished.length, startedKept: 0 });
    expect(trackOf(project)).toBe(to);
    const after = assignmentsOf(project).map((a) => a.id);
    for (const w of withdrawn) expect(after).not.toContain(w.id);
    for (const f of finished) expect(after).toContain(f.id);
    expect(finishedReviews(getDb(), "evt_01").filter((r) => r.projectId === project)).toHaveLength(counted);

    const row = auditRows().at(-1)!;
    expect(row).toMatchObject({ action: "project.track_moved", targetId: project, before: { trackId: from } });
    expect(row.after).toMatchObject({ trackId: to, reason: "The team entered the wrong track", finishedKept: finished.map((f) => f.id) });
    expect(verifyAuditChain(getDb()).ok).toBe(true);
    const words = latestAudit(getDb(), "evt_01", 1, ["project.track_moved"])[0]!.parts.map((p) => p.text).join("");
    expect(words).toContain("The team entered the wrong track");
    expect(words).toMatch(/withdrawing \d+ unstarted review/);
  });

  it("the next top-up gives the project judges from its new track", () => {
    const { project, to } = setUp();
    moveProjectTrack(organizer(), "evt_01", project, { trackId: to, reason: "wrong track" });
    const run = runAssignment(organizer(), "evt_01", { mode: "topup", seed: 5 });
    const added = sqlAll<{ j: string }>("SELECT judge_user_id AS j FROM assignments WHERE run_id = ? AND project_id = ?", run.runId, project).map((r) => r.j);
    expect(added.length).toBeGreaterThan(0);
    for (const j of added) expect(judgesIn(to)).toContain(j);
  });

  it("a judge of both tracks keeps their open review; a started one stays in the record but leaves its judge's console", () => {
    const { project, to } = setUp();
    const open = assignmentsOf(project).filter((a) => a.status === "pending" && !a.started && !hasTrack(a.judge, to));
    expect(open.length).toBeGreaterThanOrEqual(2);
    const [both, started] = open;
    const tracks = sqlAll<{ t: string }>("SELECT track_id AS t FROM judge_tracks WHERE judge_user_id = ? AND event_id = 'evt_01'", both!.judge).map((r) => r.t);
    setJudgeTracks(organizer(), "evt_01", both!.judge, { trackIds: [...tracks, to] });
    saveReview(actorById(started!.judge), started!.id, { feedback: "halfway through" });

    const out = moveProjectTrack(organizer(), "evt_01", project, { trackId: to, reason: "wrong track" });
    expect(out.startedKept).toBe(1);
    const ids = assignmentsOf(project).map((a) => a.id);
    expect(ids).toContain(both!.id);
    expect(ids).toContain(started!.id);
    expect(getJudgeConsole(actorById(both!.judge), "evt_01").items.some((i) => i.assignmentId === both!.id)).toBe(true);
    expect(getJudgeConsole(actorById(started!.judge), "evt_01").items.some((i) => i.assignmentId === started!.id)).toBe(false);
  });

  it("the same track changes nothing and writes no row; a merged copy is refused (409)", () => {
    const { project, from, to } = setUp();
    const before = auditRows().length;
    expect(moveProjectTrack(organizer(), "evt_01", project, { trackId: from, reason: "no change" }).moved).toBe(false);
    expect(auditRows().length).toBe(before);
    const other = sqlGet<{ id: string }>("SELECT id FROM projects WHERE event_id = 'evt_01' AND id != ? AND status = 'submitted' ORDER BY id LIMIT 1", project)!.id;
    sqlRun("UPDATE projects SET duplicate_of = ? WHERE id = ?", project, other);
    expectHttpError(() => moveProjectTrack(organizer(), "evt_01", other, { trackId: to, reason: "move the copy" }), 409, "merged_copy");
  });

  it("refuses no session (401), a judge (403), an unknown track (422), an unknown project (404), and after publishing (409)", () => {
    const { project, from, to } = setUp();
    const judge = assignmentsOf(project)[0]!.judge;
    expectHttpError(() => moveProjectTrack(null, "evt_01", project, { trackId: to, reason: "wrong track" }), 401, "unauthenticated");
    expectHttpError(() => moveProjectTrack(actorById(judge), "evt_01", project, { trackId: to, reason: "wrong track" }), 403, "not_an_organizer");
    expectHttpError(() => moveProjectTrack(organizer(), "evt_01", project, { trackId: "trk_nowhere", reason: "wrong track" }), 422, "invalid");
    expectHttpError(() => moveProjectTrack(organizer(), "evt_01", project, { trackId: to, reason: "" }), 422, "invalid");
    expectHttpError(() => moveProjectTrack(organizer(), "evt_01", "prj_nope", { trackId: to, reason: "wrong track" }), 404, "not_found");
    sqlRun("UPDATE events SET results_published_at = '2026-09-26T13:00:00.000Z' WHERE id = 'evt_01'");
    expectHttpError(() => moveProjectTrack(organizer(), "evt_01", project, { trackId: to, reason: "wrong track" }), 409, "results_published");
    expect(trackOf(project)).toBe(from);
  });
});
