import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { assignments, auditLog, comparisons, judgeTracks } from "@/server/db/schema";
import { setJudgeTracks } from "@/server/dal/judges";
import { recuseAssignment } from "@/server/dal/reviews";
import { acceptUnderReviewed, getNormalization, getPublishedResults, kendallTauB, mergeDuplicate, publishResults, setJudgeOverride } from "@/server/dal/normalization";
import { getOverview } from "@/server/dal/overview";
import { getRecord, issueOwnRecord } from "@/server/dal/records";
import { authorize, type EventFacts } from "@/server/authz";
import { getPairwiseRanking, getPairwiseState, pickPairwise, pullShare, setJudgingMode, undoPairwise, PAIRWISE_METHOD, PULL_SHOWN_WITHIN } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";

// Pairwise mode's rules (JUDGING.md "Pairwise mode"): only the event's judges answer,
// only the question the server asks, only while judging is open and the event is in
// pairwise mode; only organizers see the ranking and switch the mode. Every refusal
// here has a positive control.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function checker(label: "organizer" | "judge_a" | "judge_b" | "participant") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
}

function outcome(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
    return { status: 200 };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status ?? 500, code: e.code };
  }
}

const toPairwise = () => setJudgingMode(checker("organizer"), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });

/** The judge's first track with a question, and the question. */
function firstQuestion(actor: ReturnType<typeof checker>) {
  const t = getPairwiseState(actor, "evt_01").tracks.find((x) => x.current)!;
  return { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, newId: t.current!.newId };
}

beforeEach(() => {
  process.env.SEED_CHECKER_SESSIONS = "true";
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
  process.env.SEED_CHECKER_SESSIONS = saved.flag;
});

describe("pairwise mode: who may do what", () => {
  it("only an organizer switches the mode, with a reason, audited; a participant or a judge is refused", () => {
    expect(outcome(() => setJudgingMode(checker("participant"), "evt_01", { mode: "pairwise", reason: "why not" }))).toMatchObject({ status: 403 });
    expect(outcome(() => setJudgingMode(checker("judge_a"), "evt_01", { mode: "pairwise", reason: "why not" }))).toMatchObject({ status: 403 });
    expect(outcome(() => setJudgingMode(checker("organizer"), "evt_01", { mode: "pairwise", reason: "" }))).toMatchObject({ status: 422 });
    expect(outcome(toPairwise).status).toBe(200);
    expect(h.db.select().from(auditLog).where(eq(auditLog.action, "event.judging_mode")).all()).toHaveLength(1);
  });

  it("in scores mode an answer is refused with 409 not_pairwise; switched, the same judge gets a question", () => {
    const judge = checker("judge_a");
    expect(getPairwiseState(judge, "evt_01").tracks).toEqual([]);
    expect(outcome(() => pickPairwise(judge, "evt_01", { trackId: "trk_01", left: "prj_01", right: "prj_02", outcome: "left" }))).toEqual({ status: 409, code: "not_pairwise" });
    toPairwise();
    expect(getPairwiseState(judge, "evt_01").tracks.some((t) => t.current)).toBe(true);
  });

  it("a participant cannot read a judge's lists or answer; the organizer (no judge role) cannot answer; the judge can", () => {
    toPairwise();
    const q = firstQuestion(checker("judge_a"));
    expect(outcome(() => getPairwiseState(checker("participant"), "evt_01"))).toMatchObject({ status: 403 });
    expect(outcome(() => pickPairwise(checker("participant"), "evt_01", { ...q, outcome: "left" }))).toMatchObject({ status: 403 });
    expect(outcome(() => pickPairwise(checker("organizer"), "evt_01", { ...q, outcome: "left" }))).toMatchObject({ status: 403 });
    expect(outcome(() => pickPairwise(checker("judge_a"), "evt_01", { ...q, outcome: "left" })).status).toBe(200);
  });

  it("answers only the question asked: swapped sides or another pair is 409 question_changed and stores nothing", () => {
    toPairwise();
    const judge = checker("judge_a");
    const q = firstQuestion(judge);
    expect(outcome(() => pickPairwise(judge, "evt_01", { trackId: q.trackId, left: q.right, right: q.left, outcome: "left" }))).toEqual({ status: 409, code: "question_changed" });
    expect(outcome(() => pickPairwise(judge, "evt_01", { trackId: q.trackId, left: q.left, right: "prj_40", outcome: "left" }))).toEqual({ status: 409, code: "question_changed" });
    expect(h.db.select().from(comparisons).all()).toHaveLength(0);
    expect(outcome(() => pickPairwise(judge, "evt_01", { ...q, outcome: "tie" })).status).toBe(200);
    expect(h.db.select().from(comparisons).all()).toHaveLength(1);
  });

  it("one judge's answers never show in another judge's state; only an organizer reads the ranking", () => {
    toPairwise();
    const a = checker("judge_a");
    pickPairwise(a, "evt_01", { ...firstQuestion(a), outcome: "left" });
    const bState = getPairwiseState(checker("judge_b"), "evt_01");
    expect(bState.judge.id).not.toBe(a.userId);
    expect(bState.tracks.reduce((n, t) => n + t.answered, 0)).toBe(0);
    expect(outcome(() => getPairwiseRanking(checker("judge_a"), "evt_01"))).toMatchObject({ status: 403 });
    expect(outcome(() => getPairwiseRanking(checker("participant"), "evt_01"))).toMatchObject({ status: 403 });
    const ranking = getPairwiseRanking(checker("organizer"), "evt_01");
    expect(ranking.counts.picks).toBe(1);
    expect(ranking.counts.fromScores).toBeGreaterThan(100);
  });

  it("undo takes back the latest answer and the same question comes back; with nothing to take back it is 409", () => {
    toPairwise();
    const judge = checker("judge_a");
    const q = firstQuestion(judge);
    expect(outcome(() => undoPairwise(judge, "evt_01", { trackId: q.trackId }))).toEqual({ status: 409, code: "nothing_to_undo" });
    pickPairwise(judge, "evt_01", { ...q, outcome: "right" });
    expect(firstQuestion(judge)).not.toEqual(q);
    undoPairwise(judge, "evt_01", { trackId: q.trackId });
    expect(firstQuestion(judge)).toEqual(q);
    expect(h.db.select().from(comparisons).where(eq(comparisons.trackId, q.trackId)).all()[0]!.voidedAt).not.toBeNull();
  });

  it("the Overview pipeline says Comparing and Ranking in pairwise mode and counts what judges placed", () => {
    const stage = (no: string) => getOverview(checker("organizer"), "evt_01").pipeline.find((s) => s.no === no)!;
    expect(stage("06").name).toBe("Scoring");
    toPairwise();
    expect([stage("06").name, stage("07").name]).toEqual(["Comparing", "Ranking"]);
    const before = stage("06").state;
    const judge = checker("judge_a");
    pickPairwise(judge, "evt_01", { ...firstQuestion(judge), outcome: "left" });
    const placed = (state: string) => Number(state.split(" of ")[0]);
    expect(placed(stage("06").state)).toBe(placed(before) + 1);
    expect(stage("07").state).toBe("1 answer");
  });

  it("an answer stops counting once the judge recuses from either project, as a recused review does", () => {
    toPairwise();
    const judge = checker("judge_a");
    const q = firstQuestion(judge);
    pickPairwise(judge, "evt_01", { ...q, outcome: "left" });
    const org = checker("organizer");
    expect(getPairwiseRanking(org, "evt_01").counts.picks).toBe(1);
    const assignment = h.db
      .select()
      .from(assignments)
      .where(and(eq(assignments.judgeUserId, judge.userId), eq(assignments.projectId, q.newId)))
      .get()!;
    recuseAssignment(judge, assignment.id, { reason: "I mentored this team" });
    expect(getPairwiseRanking(org, "evt_01").counts.picks).toBe(0);
    // ...and the project leaves the judge's pairwise list (the Compare screen offers the same declaration)
    const track = getPairwiseState(judge, "evt_01").tracks.find((t) => t.trackId === q.trackId)!;
    expect(track.projects.some((p) => p.id === q.newId)).toBe(false);
    expect(track.projects.every((p) => typeof p.assignmentId === "string" && p.assignmentId.length > 0)).toBe(true);
  });

  it("a track taken from the judge leaves their pairwise lists too", () => {
    toPairwise();
    const judge = checker("judge_a");
    const before = getPairwiseState(judge, "evt_01").tracks.map((t) => t.trackId);
    expect(before.length).toBeGreaterThan(1);
    const keep = before.slice(1);
    setJudgeTracks(checker("organizer"), "evt_01", judge.userId, { trackIds: keep });
    expect(getPairwiseState(judge, "evt_01").tracks.map((t) => t.trackId)).toEqual(keep);
    expect(h.db.select().from(judgeTracks).where(and(eq(judgeTracks.judgeUserId, judge.userId), eq(judgeTracks.trackId, before[0]!))).all()).toHaveLength(0);
  });
});

describe("the two pulls, as people see them", () => {
  it("are shown only once known within the stated ± (known-bad: a handful of answers is not a finding)", () => {
    expect(pullShare(null)).toBeNull();
    expect(pullShare({ est: 0.3, se: 0.1 })).toMatchObject({ pm: 2, measured: true });
    expect(pullShare({ est: 0.1, se: 0.5 })).toMatchObject({ pm: 12, measured: false });
    toPairwise();
    const judge = checker("judge_a");
    for (let k = 0; k < 2; k++) pickPairwise(judge, "evt_01", { ...firstQuestion(judge), outcome: "left" });
    const r = getPairwiseRanking(checker("organizer"), "evt_01");
    expect(r.counts.picks).toBe(2);
    expect(pullShare(r.left)!.measured).toBe(false);
    expect(pullShare(r.left)!.pm).toBeGreaterThan(PULL_SHOWN_WITHIN);
  });
});

describe("the scores-mode cross-check", () => {
  it("Kendall's tau-b: 1 for the same order, -1 for the reverse, ties handled, null when nothing is ordered", () => {
    expect(kendallTauB([1, 2, 3, 4], [1, 2, 3, 4])).toBe(1);
    expect(kendallTauB([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(kendallTauB([1, 2, 3], [1, 3, 2])).toBeCloseTo(1 / 3, 10);
    expect(kendallTauB([1, 1, 2], [1, 2, 3])).toBeCloseTo(2 / Math.sqrt(6), 10);
    expect(kendallTauB([1, 1], [1, 2])).toBeNull();
  });

  it("on the sample event, ranks the same reviews as comparisons and agrees clearly but not perfectly with the normalized order; not in pairwise mode", () => {
    const org = checker("organizer");
    const check = getNormalization(org, "evt_01").crossCheck!;
    expect(check.tracks.length).toBeGreaterThanOrEqual(7);
    // the number JUDGING.md quotes
    expect(check.overall!.toFixed(2)).toBe("0.78");
    expect(Math.min(...check.tracks.map((t) => t.tau!)).toFixed(2)).toBe("0.33");
    expect(check.tracks.every((t) => t.projects >= 2 && t.movers.length <= 3)).toBe(true);
    toPairwise();
    expect(getNormalization(org, "evt_01").crossCheck).toBeNull();
    // Known-bad: answers given in pairwise mode must not reach the scores-mode cross-check.
    const judge = checker("judge_a");
    for (let k = 0; k < 3; k++) pickPairwise(judge, "evt_01", { ...firstQuestion(judge), outcome: "right" });
    setJudgingMode(org, "evt_01", { mode: "scores", reason: "back to scores" });
    expect(getNormalization(org, "evt_01").crossCheck).toEqual(check);
  });
});

describe("pairwise mode: publishing", () => {
  it("needs its own decisions settled, stores a Bradley-Terry run the results page reads, and then answers and the mode are final", () => {
    toPairwise();
    const org = checker("organizer");
    const judge = checker("judge_a");
    pickPairwise(judge, "evt_01", { ...firstQuestion(judge), outcome: "left" });
    expect(outcome(() => publishResults(org, "evt_01"))).toEqual({ status: 409, code: "decisions_open" });
    mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "only one judge compared it" });
    setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "flat scores" });
    expect(outcome(() => publishResults(org, "evt_01")).status).toBe(200);
    const published = getPublishedResults("evt_01");
    if (!published.published) throw new Error("not published");
    expect(published.method).toBe(PAIRWISE_METHOD);
    const rows = published.tracks.flatMap((t) => t.rows);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.every((r) => r.score === null || (r.score > 0 && r.score < 1))).toBe(true);
    expect(outcome(() => pickPairwise(judge, "evt_01", { ...firstQuestion(judge), outcome: "left" }))).toMatchObject({ status: 403, code: "results_published" });
    expect(outcome(() => setJudgingMode(org, "evt_01", { mode: "scores", reason: "go back" }))).toEqual({ status: 409, code: "results_published" });
    // The judge's signed record counts their answers.
    const record = getRecord(issueOwnRecord(judge, "evt_01", "judge").id).envelope.record as { judging: { finishedReviews: number; answers?: number } };
    expect(record.judging.answers).toBe(1);
  });

  it("a judge with pairwise answers and no finished review may have a record; with neither, not (known-bad)", () => {
    const judge = checker("judge_a");
    const event: EventFacts = { id: "evt_01", submissionsOpenAt: null, submissionsCloseAt: "2026-09-20T18:00:00.000Z", resultsPublishedAt: NOW };
    const subject = (finishedReviews: number, answers: number) =>
      authorize(judge, "record.issue_own", { kind: "record_subject", event, recordKind: "judge", finishedReviews, answers, onSubmittedTeam: false }, new Date(NOW));
    expect(subject(0, 3).ok).toBe(true);
    expect(subject(2, 0).ok).toBe(true);
    expect(subject(0, 0)).toMatchObject({ ok: false, code: "no_finished_reviews" });
  });
});
