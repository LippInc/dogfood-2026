import { describe, expect, it } from "vitest";
import { assignByHand } from "@/server/dal/assignments";
import { removeJudge } from "@/server/dal/corrections";
import { acceptUnderReviewed, decisions, mergeDuplicate, revokeJudgeOverride, setJudgeOverride } from "@/server/dal/decisions";
import { acceptJudgeInvite, getJudges, inviteJudge, revokeJudgeInvite } from "@/server/dal/judges";
import { judgeSet, rubricOf } from "@/server/dal/judging";
import { computeNormalization } from "@/server/dal/normalization";
import { getMyWork } from "@/server/dal/projects";
import { publishResults } from "@/server/dal/results";
import { getJudgeConsole, saveReview } from "@/server/dal/reviews";
import { requireEvent } from "@/server/dal/events";
import { latestAudit } from "@/server/dal/audit-log";
import { verifyAuditChain } from "@/server/audit";
import { getDb } from "@/server/db/client";
import { actorById, addUser, auditRows, count, expectHttpError, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Before this, an open invitation accepted by the wrong account left an impostor judge for
// good: no action removed a judge, and revoking the used invitation said "remove the judge's
// tracks instead" while a judge must keep at least one. An organizer now removes a judge with a
// reason: role and tracks end, unstarted reviews are withdrawn, and whatever they saved stays on
// record, left out of the ranking, named on the receipts as removed, never shown to teams.

withFixtureEvent();

const isJudge = (id: string) => count("SELECT count(*) AS n FROM user_roles WHERE user_id = ? AND event_id = 'evt_01' AND role = 'judge'", id) > 0;
const normalization = () => computeNormalization(getDb(), requireEvent(getDb(), "evt_01"));
const submittedIn = (track: string) =>
  sqlAll<{ id: string }>("SELECT id FROM projects WHERE event_id = 'evt_01' AND status = 'submitted' AND duplicate_of IS NULL AND track_id = ? ORDER BY id", track).map((r) => r.id);

/** An open link taken by the wrong account, which then gets two projects by hand and finishes one of them. */
function impostor() {
  const invite = inviteJudge(organizer(), "evt_01", { name: "Dana", email: "", trackIds: ["trk_01"] });
  const wrong = addUser("usr_wrong", "wrong@example.org", "Wrong Person");
  acceptJudgeInvite(wrong, invite.code);
  const [scored, untouched] = submittedIn("trk_01");
  const byHand = (projectId: string) => assignByHand(organizer(), "evt_01", { projectId, judgeUserId: "usr_wrong", reason: "one more reviewer" });
  byHand(scored!);
  byHand(untouched!);
  const asg = (p: string) => sqlGet<{ id: string }>("SELECT id FROM assignments WHERE judge_user_id = 'usr_wrong' AND project_id = ?", p)!.id;
  const values = Object.fromEntries(rubricOf(getDb(), "evt_01").map((c) => [c.key, c.scaleMax]));
  saveReview(actorById("usr_wrong"), asg(scored!), { values, feedback: "whatever" });
  return { invite, scored: scored!, untouched: untouched!, scoredAsg: asg(scored!), untouchedAsg: asg(untouched!) };
}

describe("removeJudge", () => {
  it("removes an impostor: role and tracks end, the unstarted review is withdrawn, the finished one stays on record out of the ranking", () => {
    const i = impostor();
    const receiptBefore = normalization().projects.find((p) => p.id === i.scored)!.receipts.find((r) => r.judgeId === "usr_wrong")!;
    expect(receiptBefore).toMatchObject({ excluded: false, removed: false }); // positive control: counted while a judge

    const out = removeJudge(organizer(), "evt_01", "usr_wrong", { reason: "An open link taken by the wrong account" });
    expect(out).toEqual({ removed: "usr_wrong", withdrawn: 1, kept: 1, voided: true });
    expect(isJudge("usr_wrong")).toBe(false);
    expect(count("SELECT count(*) AS n FROM judge_tracks WHERE judge_user_id = 'usr_wrong'")).toBe(0);
    expect(count("SELECT count(*) AS n FROM assignments WHERE id = ?", i.untouchedAsg)).toBe(0);
    expect(count("SELECT count(*) AS n FROM assignments WHERE id = ?", i.scoredAsg)).toBe(1);
    expect(count("SELECT count(*) AS n FROM scores WHERE assignment_id = ?", i.scoredAsg)).toBe(1);

    // voided: left out by an exclusion carrying the reason, and the receipt names the judge as removed
    expect(judgeSet(getDb(), "evt_01").excluded).toContain("usr_wrong");
    const override = judgeSet(getDb(), "evt_01").overrides.find((o) => o.judgeId === "usr_wrong")!;
    expect(override).toMatchObject({ mode: "exclude", reason: "Removed as a judge: An open link taken by the wrong account" });
    const n = normalization();
    const receipt = n.projects.find((p) => p.id === i.scored)!.receipts.find((r) => r.judgeId === "usr_wrong")!;
    expect(receipt).toMatchObject({ judge: "Wrong Person", excluded: true, removed: true });
    expect(n.judges.find((j) => j.id === "usr_wrong")).toMatchObject({ name: "Wrong Person", removed: true, excluded: true, n: 0, nAll: 1 });

    const row = auditRows().at(-1)!;
    expect(row).toMatchObject({ action: "judge.remove", targetType: "user", targetId: "usr_wrong", before: { trackIds: ["trk_01"] } });
    expect(row.after).toMatchObject({ reason: "An open link taken by the wrong account", withdrawn: [i.untouchedAsg], kept: [i.scoredAsg], voided: true });
    expect(verifyAuditChain(getDb()).ok).toBe(true);
    const words = latestAudit(getDb(), "evt_01", 1, ["judge.remove"])[0]!.parts.map((p) => p.text).join("");
    expect(words).toContain("removed Wrong Person as a judge, leaving what they saved out of the ranking, and withdrew 1 unstarted review");

    const judges = getJudges(organizer(), "evt_01");
    expect(judges.judges.some((j) => j.id === "usr_wrong")).toBe(false);
    expect(judges.removed).toEqual([expect.objectContaining({ id: "usr_wrong", name: "Wrong Person", reason: "An open link taken by the wrong account" })]);
  });

  it("the removed account is refused everywhere a judge goes, even by its own used link, and its exclusion cannot be undone while it is out", () => {
    const i = impostor();
    removeJudge(organizer(), "evt_01", "usr_wrong", { reason: "wrong account" });
    const wrong = actorById("usr_wrong");
    expectHttpError(() => getJudgeConsole(wrong, "evt_01"), 403, "not_a_judge_here");
    expectHttpError(() => saveReview(wrong, i.scoredAsg, { feedback: "changed" }), 403, "not_a_judge_here");
    expectHttpError(() => acceptJudgeInvite(wrong, i.invite.code), 409, "judge_removed");
    expect(isJudge("usr_wrong")).toBe(false);
    expectHttpError(() => revokeJudgeOverride(organizer(), "evt_01", { judgeUserId: "usr_wrong" }), 409, "judge_removed");
    expect(judgeSet(getDb(), "evt_01").excluded).toContain("usr_wrong");
  });

  it("a removed judge invited again judges again, still left out until an organizer reinstates them with a reason", () => {
    impostor();
    removeJudge(organizer(), "evt_01", "usr_wrong", { reason: "removed by mistake" });
    const again = inviteJudge(organizer(), "evt_01", { name: "Dana again", email: "wrong@example.org", trackIds: ["trk_01"] });
    acceptJudgeInvite(actorById("usr_wrong"), again.code);
    expect(isJudge("usr_wrong")).toBe(true);
    expect(judgeSet(getDb(), "evt_01").excluded).toContain("usr_wrong");
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "usr_wrong", mode: "include", reason: "It was the right person after all" });
    expect(judgeSet(getDb(), "evt_01").excluded).not.toContain("usr_wrong");
    expect(getJudges(organizer(), "evt_01").removed).toEqual([]);
  });

  it("a judge who saved nothing leaves no exclusion behind", () => {
    const invite = inviteJudge(organizer(), "evt_01", { name: "", email: "", trackIds: ["trk_02"] });
    addUser("usr_idle", "idle@example.org", "Idle");
    acceptJudgeInvite(actorById("usr_idle"), invite.code);
    expect(removeJudge(organizer(), "evt_01", "usr_idle", { reason: "never showed up" })).toEqual({ removed: "usr_idle", withdrawn: 0, kept: 0, voided: false });
    expect(count("SELECT count(*) AS n FROM judge_overrides WHERE judge_user_id = 'usr_idle'")).toBe(0);
    expect(normalization().judges.some((j) => j.id === "usr_idle")).toBe(false);
  });

  it("the used invitation's revoke message now points at removing the judge", () => {
    const invite = inviteJudge(organizer(), "evt_01", { name: "", email: "", trackIds: ["trk_02"] });
    acceptJudgeInvite(addUser("usr_x", "x@example.org", "X"), invite.code);
    const refusal = expectHttpError(() => revokeJudgeInvite(organizer(), invite.id), 409, "invite_used");
    expect(refusal.message).toContain("remove the judge on the Judges page");
    expect(refusal.message).not.toContain("tracks");
  });

  it("refuses no session (401), a judge removing another (403), a non-judge (404), no reason (422), and after publishing (409)", () => {
    impostor();
    expectHttpError(() => removeJudge(null, "evt_01", "usr_wrong", { reason: "wrong account" }), 401, "unauthenticated");
    expectHttpError(() => removeJudge(actorById("jdg_24"), "evt_01", "usr_wrong", { reason: "wrong account" }), 403, "not_an_organizer");
    expectHttpError(() => removeJudge(actorById("usr_wrong"), "evt_01", "jdg_24", { reason: "I remove you" }), 403, "not_an_organizer");
    expectHttpError(() => removeJudge(organizer(), "evt_01", "usr_organizer", { reason: "not a judge" }), 404, "not_found");
    expectHttpError(() => removeJudge(organizer(), "evt_01", "usr_wrong", { reason: "" }), 422, "invalid");
    sqlRun("UPDATE events SET results_published_at = '2026-09-26T13:00:00.000Z' WHERE id = 'evt_01'");
    expectHttpError(() => removeJudge(organizer(), "evt_01", "usr_wrong", { reason: "wrong account" }), 409, "results_published");
    expect(isJudge("usr_wrong")).toBe(true);
  });

  it("after publishing, the team never sees a removed judge's review, and the published run records the removal", () => {
    // A fixture judge with a finished review of a project whose team has a member account.
    const pick = sqlGet<{ judge: string; project: string; member: string }>(
      `SELECT a.judge_user_id AS judge, a.project_id AS project, tm.user_id AS member
         FROM assignments a JOIN projects p ON p.id = a.project_id JOIN team_members tm ON tm.team_id = p.team_id
        WHERE a.status = 'done' AND a.judge_user_id != 'jdg_07' AND p.duplicate_of IS NULL AND p.id NOT IN ('prj_07', 'prj_41')
        ORDER BY a.id LIMIT 1`,
    )!;
    removeJudge(organizer(), "evt_01", pick.judge, { reason: "Left the event before judging closed" });
    // settle every open decision the way the fixture's own tests do, then publish
    const event = requireEvent(getDb(), "evt_01");
    for (const d of decisions(getDb(), event)) {
      if (d.resolved) continue;
      if (d.kind === "flat_judge") setJudgeOverride(organizer(), "evt_01", { judgeUserId: d.judgeId, mode: "exclude", reason: "Flat vector, confirmed" });
      else if (d.kind === "duplicate") mergeDuplicate(organizer(), "evt_01", { keepId: d.copies[0]!.id, duplicateId: d.copies[1]!.id });
      else if (d.kind === "under_reviewed") acceptUnderReviewed(organizer(), "evt_01", { projectId: d.projectId, reason: "Publish with what it has" });
    }
    publishResults(organizer(), "evt_01");
    const all = sqlGet<{ n: number }>(
      "SELECT count(*) AS n FROM assignments a JOIN scores s ON s.assignment_id = a.id WHERE a.project_id = ? AND a.status = 'done' AND s.submitted_at IS NOT NULL",
      pick.project,
    )!.n;
    const feedback = getMyWork(actorById(pick.member), "evt_01").feedback!;
    expect(feedback.reviews.length).toBe(all - 1);
    const run = sqlGet<{ params: string }>("SELECT params FROM normalization_runs WHERE event_id = 'evt_01' ORDER BY computed_at DESC LIMIT 1")!;
    expect(run.params).toContain("Removed as a judge: Left the event before judging closed");
  });
});
