import { describe, expect, it } from "vitest";
import { getAssignments, runAssignment, assignByHand } from "@/server/dal/assignments";
import { getProjectJudging, removeAssignment, undoRecusal } from "@/server/dal/corrections";
import { getJudgeConsole, recuseAssignment, saveReview } from "@/server/dal/reviews";
import { latestAudit } from "@/server/dal/audit-log";
import { verifyAuditChain } from "@/server/audit";
import { getDb } from "@/server/db/client";
import { actorById, addUser, auditRows, count, expectHttpError, organizer, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Before this, a by-hand assignment could never be undone (the wrong judge had to score or
// recuse) and a recusal clicked by mistake was final. An organizer can now take back an
// assignment nobody started and undo a recusal, each with a reason, audited, and never after
// the results are published.

withFixtureEvent();

type Row = { id: string; judge: string; project: string; status: string };
const assignment = (id: string) => sqlGet<Row>("SELECT id, judge_user_id AS judge, project_id AS project, status FROM assignments WHERE id = ?", id);

/** A fresh open review nobody has touched, from a top-up of the fixture. */
function openReview(): Row {
  runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
  return sqlGet<Row>(
    "SELECT a.id, a.judge_user_id AS judge, a.project_id AS project, a.status FROM assignments a WHERE a.status = 'pending' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id) ORDER BY a.id",
  )!;
}

/** One of the fixture's finished reviews. */
const finishedReview = () => sqlGet<Row>("SELECT id, judge_user_id AS judge, project_id AS project, status FROM assignments WHERE status = 'done' ORDER BY id")!;

const sentence = (action: string) => latestAudit(getDb(), "evt_01", 1, [action])[0]!.parts.map((p) => p.text).join("");

describe("removeAssignment", () => {
  it("takes back an untouched review with its reason: the row goes, one audit row, the chain holds", () => {
    const open = openReview();
    const before = auditRows().length;
    const out = removeAssignment(organizer(), "evt_01", open.id, { reason: "Picked the wrong Mira" });
    expect(out).toEqual({ removed: open.id, projectId: open.project, judgeUserId: open.judge });
    expect(assignment(open.id)).toBeUndefined();
    const rows = auditRows();
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toMatchObject({
      action: "assignment.remove",
      targetType: "project",
      targetId: open.project,
      before: { assignment: open.id, judgeUserId: open.judge, status: "pending" },
      after: { judgeUserId: open.judge, reason: "Picked the wrong Mira" },
    });
    expect(verifyAuditChain(getDb()).ok).toBe(true);
    expect(sentence("assignment.remove")).toContain("Picked the wrong Mira");
    expect(getJudgeConsole(actorById(open.judge), "evt_01").items.some((i) => i.assignmentId === open.id)).toBe(false);
  });

  it("no run gives a taken-back pair again, while an organizer still can by hand", () => {
    const open = openReview();
    removeAssignment(organizer(), "evt_01", open.id, { reason: "Picked the wrong judge" });
    for (const seed of [1, 2, 3, 42]) runAssignment(organizer(), "evt_01", { mode: "topup", seed });
    expect(count("SELECT count(*) AS n FROM assignments WHERE judge_user_id = ? AND project_id = ?", open.judge, open.project)).toBe(0);
    assignByHand(organizer(), "evt_01", { projectId: open.project, judgeUserId: open.judge, reason: "It was the right one after all" });
    expect(count("SELECT count(*) AS n FROM assignments WHERE judge_user_id = ? AND project_id = ?", open.judge, open.project)).toBe(1);
  });

  it("known-bad: the engine alone would give the same pair back (the rule is what stops it)", () => {
    // The same pair deleted with no taken-back record (a raw delete, no audit row): the same
    // fixed-seed top-up picks the same judge again. So the test above passes because of the rule.
    const open = openReview();
    sqlRun("DELETE FROM assignments WHERE id = ?", open.id);
    runAssignment(organizer(), "evt_01", { mode: "topup", seed: 42 });
    expect(count("SELECT count(*) AS n FROM assignments WHERE judge_user_id = ? AND project_id = ?", open.judge, open.project)).toBe(1);
    expect(getAssignments(organizer(), "evt_01").wouldAdd).toBe(0);
  });

  it("keeps a review the judge started (409 review_started), a recusal (409 recused), and everything once published", () => {
    const open = openReview();
    saveReview(actorById(open.judge), open.id, { feedback: "first thoughts" });
    expectHttpError(() => removeAssignment(organizer(), "evt_01", open.id, { reason: "wrong judge" }), 409, "review_started");
    expect(assignment(open.id)).toBeDefined();

    const done = finishedReview();
    recuseAssignment(actorById(done.judge), done.id, { reason: "I mentor this team" });
    expectHttpError(() => removeAssignment(organizer(), "evt_01", done.id, { reason: "wrong judge" }), 409, "recused");

    const another = sqlGet<Row>("SELECT id FROM assignments a WHERE status = 'pending' AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.assignment_id = a.id)")!;
    sqlRun("UPDATE events SET results_published_at = '2026-09-26T13:00:00.000Z' WHERE id = 'evt_01'");
    expectHttpError(() => removeAssignment(organizer(), "evt_01", another.id, { reason: "wrong judge" }), 409, "results_published");
    expect(assignment(another.id)).toBeDefined();
  });

  it("refuses no session (401), a judge and a participant (403), a missing reason (422) and an unknown id (404)", () => {
    const open = openReview();
    const before = auditRows().filter((r) => r.action === "assignment.remove").length;
    expectHttpError(() => removeAssignment(null, "evt_01", open.id, { reason: "wrong judge" }), 401, "unauthenticated");
    expectHttpError(() => removeAssignment(actorById(open.judge), "evt_01", open.id, { reason: "not mine" }), 403, "not_an_organizer");
    expectHttpError(() => removeAssignment(addUser("usr_p", "p@example.org", "P"), "evt_01", open.id, { reason: "x y z" }), 403, "not_an_organizer");
    expectHttpError(() => removeAssignment(organizer(), "evt_01", open.id, { reason: "" }), 422, "invalid");
    expectHttpError(() => removeAssignment(organizer(), "evt_01", "asg_nope", { reason: "wrong judge" }), 404, "not_found");
    expect(assignment(open.id)).toBeDefined();
    expect(auditRows().filter((r) => r.action === "assignment.remove")).toHaveLength(before);
  });
});

describe("undoRecusal", () => {
  it("gives a finished review back as finished, audited with the organizer's reason; the judge sees it again", () => {
    const done = finishedReview();
    recuseAssignment(actorById(done.judge), done.id, { reason: "clicked the wrong row" });
    expect(assignment(done.id)!.status).toBe("recused");
    const recusal = getProjectJudging(organizer(), "evt_01", done.project).assignments.find((a) => a.id === done.id)!;
    expect(recusal).toMatchObject({ status: "recused", recuseReason: "clicked the wrong row", started: true });

    expect(undoRecusal(organizer(), "evt_01", done.id, { reason: "The judge says it was a misclick" })).toEqual({ assignmentId: done.id, status: "done" });
    expect(assignment(done.id)!.status).toBe("done");
    expect(auditRows().at(-1)).toMatchObject({
      action: "assignment.recusal_undone",
      targetId: done.id,
      before: { status: "recused" },
      after: { status: "done", project: done.project, judgeUserId: done.judge, reason: "The judge says it was a misclick" },
    });
    expect(sentence("assignment.recusal_undone")).toContain("undoing their recusal");
    const item = getJudgeConsole(actorById(done.judge), "evt_01").items.find((i) => i.assignmentId === done.id)!;
    expect(item.status).toBe("done");
    expect(item.readOnly).toBeNull();
  });

  it("an unstarted recused review comes back open; a review that is not recused changes nothing", () => {
    const open = openReview();
    recuseAssignment(actorById(open.judge), open.id, { reason: "conflict" });
    expect(undoRecusal(organizer(), "evt_01", open.id, { reason: "not a conflict" }).status).toBe("pending");
    const before = auditRows().length;
    expect(undoRecusal(organizer(), "evt_01", open.id, { reason: "again" }).status).toBe("pending");
    expect(auditRows().length).toBe(before);
  });

  it("refuses a person who is no longer a judge (409), after publishing (409), and anyone but an organizer", () => {
    const done = finishedReview();
    recuseAssignment(actorById(done.judge), done.id, { reason: "conflict" });
    expectHttpError(() => undoRecusal(null, "evt_01", done.id, { reason: "misclick" }), 401, "unauthenticated");
    expectHttpError(() => undoRecusal(actorById(done.judge), "evt_01", done.id, { reason: "misclick" }), 403, "not_an_organizer");
    expectHttpError(() => undoRecusal(organizer(), "evt_01", done.id, {}), 422, "invalid");

    sqlRun("DELETE FROM user_roles WHERE user_id = ? AND event_id = 'evt_01' AND role = 'judge'", done.judge);
    expectHttpError(() => undoRecusal(organizer(), "evt_01", done.id, { reason: "misclick" }), 409, "not_a_judge");
    sqlRun("INSERT INTO user_roles (user_id, event_id, role, created_at) VALUES (?, 'evt_01', 'judge', '2026-09-26T12:00:00.000Z')", done.judge);

    sqlRun("UPDATE events SET results_published_at = '2026-09-26T13:00:00.000Z' WHERE id = 'evt_01'");
    expectHttpError(() => undoRecusal(organizer(), "evt_01", done.id, { reason: "misclick" }), 409, "results_published");
    expect(assignment(done.id)!.status).toBe("recused");
  });
});

describe("getProjectJudging", () => {
  it("is the organizers' alone, and a project of no event is a 404", () => {
    const done = finishedReview();
    expect(getProjectJudging(organizer(), "evt_01", done.project).assignments.length).toBeGreaterThan(0);
    expectHttpError(() => getProjectJudging(actorById(done.judge), "evt_01", done.project), 403, "not_an_organizer");
    expectHttpError(() => getProjectJudging(null, "evt_01", done.project), 401, "unauthenticated");
    expectHttpError(() => getProjectJudging(organizer(), "evt_01", "prj_nope"), 404, "not_found");
  });
});
