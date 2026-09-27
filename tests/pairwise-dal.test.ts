import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { auditLog, comparisons, judgeTracks } from "@/server/db/schema";
import { setJudgeTracks } from "@/server/dal/judges";
import { acceptUnderReviewed, getPublishedResults, mergeDuplicate, publishResults, setJudgeOverride } from "@/server/dal/normalization";
import { getRecord, issueOwnRecord } from "@/server/dal/records";
import { authorize, type EventFacts } from "@/server/authz";
import { getPairwiseRanking, getPairwiseState, pickPairwise, setJudgingMode, undoPairwise, PAIRWISE_METHOD } from "@/server/dal/pairwise";
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
