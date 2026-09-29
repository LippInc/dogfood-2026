import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { awardPlace, competitionPlaces } from "@/lib/places";
import { breakTies, criterionMeans } from "@/server/judging/tiebreak";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { exportFile } from "@/server/dal/exports";
import { createEvent, saveRubric } from "@/server/dal/organize";
import { setJudgingMode } from "@/server/dal/pairwise";
import { getRecord, issueOwnRecord } from "@/server/dal/records";
import { getMyWork } from "@/server/dal/projects";
import { getNormalization, getPublishedResults, publishResults } from "@/server/dal/results";
import { setTieBreak } from "@/server/dal/tiebreak";
import { scoreCandidates } from "@/server/dal/prize-candidates";
import { latestAudit } from "@/server/dal/audit-log";
import { getDb } from "@/server/db/client";
import { actorById, addUser, auditRows, expectHttpError, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The tie-break stage (JUDGING.md, "Breaking exact ties"): an organizer may name one rubric criterion that orders
// projects whose scores are exactly tied within a track. The fixture's prj_05 and prj_21 (Data and analytics) are
// reviewed by the same three judges; giving prj_21 each judge's prj_05 review with functionality and innovation
// swapped plants an exact tie (same totals from the same judges) that the two criteria split in opposite ways and
// quality does not split at all.

withFixtureEvent();

const crit = (key: string) => sqlGet<{ id: string }>("SELECT id FROM rubric_criteria WHERE event_id = 'evt_01' AND key = ?", key)!.id;

function plantTie() {
  // equal weights, so swapping two criteria keeps every review's total
  sqlRun("UPDATE rubric_criteria SET weight = 1 WHERE event_id = 'evt_01'");
  const f = crit("functionality");
  const q = crit("quality");
  const i = crit("innovation");
  const items = (project: string) =>
    sqlAll<{ judge: string; scoreId: string; criterionId: string; value: number }>(
      "SELECT a.judge_user_id AS judge, s.id AS scoreId, si.criterion_id AS criterionId, si.value AS value FROM assignments a JOIN scores s ON s.assignment_id = a.id JOIN score_items si ON si.score_id = s.id WHERE a.project_id = ?",
      project,
    );
  const from = items("prj_05");
  const to = items("prj_21");
  const swap = new Map([
    [f, i],
    [i, f],
    [q, q],
  ]);
  for (const t of to) {
    const src = from.find((x) => x.judge === t.judge && x.criterionId === swap.get(t.criterionId))!;
    sqlRun("UPDATE score_items SET value = ? WHERE score_id = ? AND criterion_id = ?", src.value, t.scoreId, t.criterionId);
  }
}

function settleAndPublish() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  publishResults(organizer(), "evt_01");
}

const trackRows = () => {
  const r = getPublishedResults("evt_01");
  if (!r.published) throw new Error("not published");
  const t = r.tracks.find((x) => x.rows.some((row) => row.projectId === "prj_05"))!;
  const places = competitionPlaces(t.rows);
  return { results: r, rows: t.rows.map((row, k) => ({ ...row, ...places[k]! })) };
};
const reason = "Announced to teams at kickoff";

describe("the pure stage", () => {
  it("orders an exact score tie by the criterion, higher first, and places only the still-tied rows jointly", () => {
    const rows = [
      { projectId: "a", score: 4 },
      { projectId: "b", score: 3 },
      { projectId: "c", score: 3 + 1e-12 },
      { projectId: "d", score: 3 },
      { projectId: "e", score: 2 },
    ];
    const out = breakTies(rows, new Map([["b", 2], ["c", 4], ["d", 2], ["a", 1], ["e", 5]]));
    expect(out.map((r) => r.projectId)).toEqual(["a", "c", "b", "d", "e"]);
    expect(out.map((r) => r.tie)).toEqual([null, 4, 2, 2, null]);
    expect(out.map((r) => r.tieBroken)).toEqual([false, true, true, true, false]);
    expect(competitionPlaces(out)).toEqual([
      { place: 1, joint: false },
      { place: 2, joint: false },
      { place: 3, joint: true },
      { place: 3, joint: true },
      { place: 5, joint: false },
    ]);
  });

  it("keeps a tie joint when the criterion ties too, and places without figures exactly as before", () => {
    const rows = [
      { projectId: "a", score: 3 },
      { projectId: "b", score: 3 },
    ];
    const out = breakTies(rows, new Map([["a", 2.5], ["b", 2.5 + 1e-12]]));
    expect(out.map((r) => r.tieBroken)).toEqual([false, false]);
    expect(competitionPlaces(out)).toEqual([
      { place: 1, joint: true },
      { place: 1, joint: true },
    ]);
    expect(competitionPlaces(rows)).toEqual(competitionPlaces(out));
  });

  it("reads a certificate's award back into its parts, with the tie-break when it decided the place", () => {
    expect(awardPlace("Joint 1st place, Health")).toEqual({ joint: true, ordinal: "1st", place: 1, track: "Health", tieBrokenBy: null });
    expect(awardPlace("2nd place, Data and analytics, tie broken by Functionality")).toEqual({ joint: false, ordinal: "2nd", place: 2, track: "Data and analytics", tieBrokenBy: "Functionality" });
    expect(awardPlace("Winner of the community vote")).toBeNull();
  });

  it("counts a judge who scored both copies of a merged project once, then takes the mean over judges", () => {
    const means = criterionMeans([
      { judgeId: "j1", projectId: "p", value: 2 },
      { judgeId: "j1", projectId: "p", value: 4 },
      { judgeId: "j2", projectId: "p", value: 5 },
    ]);
    expect(means.get("p")).toBe(4);
  });
});

describe("the Prizes step's places", () => {
  /** every project's place and whether it is joint, as the published results give them (competitionPlaces over the stored rows) */
  const publishedPlaces = () => {
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    return new Map(r.tracks.flatMap((t) => competitionPlaces(t.rows).map((p, k) => [t.rows[k]!.projectId, { place: p.place, joint: p.joint }] as const)));
  };
  const settle = () => {
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  };
  const candidates = () => {
    const live = getNormalization(organizer(), "evt_01");
    return new Map(scoreCandidates(live.normalization, live.tieBreak).map((c) => [c.projectId, { place: c.place, joint: c.joint }]));
  };

  it("with a tie-break set, a broken tie reads 1st and 2nd before publishing as it does once published, never joint", () => {
    plantTie();
    setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality"), reason });
    settle();
    const before = candidates();
    expect(before.get("prj_05")!.joint).toBe(false);
    expect(before.get("prj_21")!.place).toBe(before.get("prj_05")!.place! + 1);
    publishResults(organizer(), "evt_01");
    expect(before).toEqual(publishedPlaces());
  });

  it("positive control: with no tie-break the planted tie is joint in both, and every other place agrees", () => {
    plantTie();
    settle();
    const before = candidates();
    expect(before.get("prj_05")).toEqual({ place: before.get("prj_21")!.place, joint: true });
    publishResults(organizer(), "evt_01");
    expect(before).toEqual(publishedPlaces());
  });
});

describe("setTieBreak", () => {
  it("resolves a planted exact tie by the criterion on every published surface, and the publish row records it", () => {
    plantTie();
    const live = getNormalization(organizer(), "evt_01");
    const a = live.normalization.projects.find((p) => p.id === "prj_05")!;
    const b = live.normalization.projects.find((p) => p.id === "prj_21")!;
    expect(Math.abs(a.score! - b.score!)).toBeLessThanOrEqual(1e-9);
    expect(live).not.toHaveProperty("tieBreak");

    expect(setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality"), reason })).toMatchObject({ changed: true, criterion: { label: expect.any(String) } });
    const view = getNormalization(organizer(), "evt_01").tieBreak!;
    const group = view.groups.find((g) => g.projects.some((p) => p.id === "prj_05"))!;
    expect(group.broken).toBe(true);
    expect(group.projects.map((p) => p.id)).toEqual(["prj_05", "prj_21"]);

    // every place earns a certificate here, so the planted pair's certificates show the rule wherever they land
    sqlRun("UPDATE events SET settings = json_set(settings, '$.certificatePlaces', 20) WHERE id = 'evt_01'");
    settleAndPublish();
    const { results, rows } = trackRows();
    expect(results.tieBreak).toEqual({ criterion: sqlGet<{ label: string }>("SELECT label FROM rubric_criteria WHERE id = ?", crit("functionality"))!.label });
    const first = rows.find((r) => r.projectId === "prj_05")!;
    const second = rows.find((r) => r.projectId === "prj_21")!;
    expect(first.joint).toBe(false);
    expect(second.joint).toBe(false);
    expect(second.place).toBe(first.place! + 1);
    expect(first.tieBroken && second.tieBroken).toBe(true);
    expect(rows.indexOf(first)).toBeLessThan(rows.indexOf(second));
    // the average place the API gives splits too
    expect(second.place! - first.place!).toBe(1);

    const publishRow = auditRows().filter((r) => r.action === "results.publish").at(-1)!;
    const tb = (publishRow.after as { tieBreak: { criterion: string; ties: { broken: boolean; projects: { id: string; place: number }[] }[] } }).tieBreak;
    expect(tb.ties.find((t) => t.projects.some((p) => p.id === "prj_05"))).toMatchObject({ broken: true, projects: [{ id: "prj_05" }, { id: "prj_21" }] });

    const csv = exportFile(organizer(), "evt_01", "normalized.csv").body;
    const lines = csv.split(/\r?\n/);
    expect(lines[0]!.endsWith(",tie_break_figure,track_place,tie_broken_by")).toBe(true);
    const line = lines.find((l) => l.startsWith("prj_21,"))!;
    expect(line.endsWith(`,${results.tieBreak!.criterion}`)).toBe(true);

    // the certificate names the place and says how it was reached
    const member = sqlGet<{ id: string }>("SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE p.id = 'prj_21' LIMIT 1")!;
    const { id } = issueOwnRecord(actorById(member.id), "evt_01", "participant");
    const awards = (getRecord(id).envelope.record as { project: { awards: string[] } }).project.awards;
    expect(awards).toContain(`${["1st", "2nd", "3rd"][second.place! - 1] ?? `${second.place}th`} place, ${results.tracks.find((t) => t.rows.some((r) => r.projectId === "prj_21"))!.name}, tie broken by ${results.tieBreak!.criterion}`);

    // the team's own My project page names the criterion beside its place; a place the tie-break did not decide has no note
    const mine = getMyWork(actorById(member.id), "evt_01").feedback!;
    expect(mine).toMatchObject({ place: second.place, tieBrokenBy: results.tieBreak!.criterion });
    const other = sqlGet<{ id: string }>(
      "SELECT tm.user_id AS id FROM team_members tm JOIN projects p ON p.team_id = tm.team_id WHERE p.event_id = 'evt_01' AND p.id NOT IN ('prj_05', 'prj_21') AND p.status = 'submitted' AND p.duplicate_of IS NULL LIMIT 1",
    )!;
    const theirs = getMyWork(actorById(other.id), "evt_01").feedback!;
    expect(theirs.place).not.toBeNull();
    expect(theirs).not.toHaveProperty("tieBrokenBy");
  });

  it("orders the other way by the other criterion, and keeps the tie joint when the criterion ties too", () => {
    plantTie();
    setTieBreak(organizer(), "evt_01", { criterionId: crit("quality"), reason });
    const view = getNormalization(organizer(), "evt_01").tieBreak!;
    expect(view.groups.find((g) => g.projects.some((p) => p.id === "prj_05"))!.broken).toBe(false);
    settleAndPublish();
    const { rows } = trackRows();
    const a = rows.find((r) => r.projectId === "prj_05")!;
    const b = rows.find((r) => r.projectId === "prj_21")!;
    expect([a.joint, b.joint, a.place === b.place, a.tieBroken, b.tieBroken]).toEqual([true, true, true, false, false]);
  });

  it("changes nothing on the sample event while unset: the published results, normalized.csv and the publish row match the pre-tie-break golden", () => {
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    const after = auditRows().filter((x) => x.action === "results.publish").at(-1)!.after;
    const snapshot = {
      results: { ...r, publishedAt: "<at>", runId: "<run>", anchor: "<anchor>" },
      csv: exportFile(organizer(), "evt_01", "normalized.csv").body,
      publishAfter: after,
    };
    const file = path.join(process.cwd(), "tests/support/tiebreak-default.golden.json");
    if (process.env.WRITE_TIEBREAK_GOLDEN === "1") fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(JSON.parse(fs.readFileSync(file, "utf8")));
  });

  it("needs a reason once judges have scored, and the published results list the change", () => {
    expectHttpError(() => setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality") }), 422, "invalid");
    setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality"), reason });
    const settings = JSON.parse(sqlGet<{ s: string }>("SELECT settings AS s FROM events WHERE id = 'evt_01'")!.s);
    expect(settings.tieBreak).toEqual({ criterionId: crit("functionality") });
    expect(settings.tieBreakChanges).toHaveLength(1);
    expect(settings.tieBreakChanges[0]).toMatchObject({ reason, before: null, after: { id: crit("functionality") } });
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    expect(r.published && r.tieBreakChanges?.[0]?.reason).toBe(reason);
  });

  it("lists a change back to joint places on the published results, even when no tie-break is set at publishing", () => {
    setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality"), reason });
    setTieBreak(organizer(), "evt_01", { criterionId: null, reason: "Joint places after all" });
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    expect(r).not.toHaveProperty("tieBreak");
    expect(r.tieBreakChanges?.map((c) => [c.before?.id ?? null, c.after?.id ?? null, c.reason])).toEqual([
      [null, crit("functionality"), reason],
      [crit("functionality"), null, "Joint places after all"],
    ]);
  });

  it("lists every change on the published results when a criterion, joint, a criterion and joint again end on joint places", () => {
    setTieBreak(organizer(), "evt_01", { criterionId: crit("functionality"), reason });
    setTieBreak(organizer(), "evt_01", { criterionId: null, reason: "Joint places after all" });
    setTieBreak(organizer(), "evt_01", { criterionId: crit("quality"), reason: "Quality, as announced" });
    setTieBreak(organizer(), "evt_01", { criterionId: null, reason: "Joint places, final" });
    settleAndPublish();
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    expect(r).not.toHaveProperty("tieBreak");
    expect(r.tieBreakChanges?.map((c) => c.reason)).toEqual([reason, "Joint places after all", "Quality, as announced", "Joint places, final"]);
    expect(r.tieBreakChanges?.at(-1)?.after).toBeNull();
  });

  it("writes one audit row per change that reads as a sentence, and none for a repeat", () => {
    setTieBreak(organizer(), "evt_01", { criterionId: crit("innovation"), reason });
    expect(setTieBreak(organizer(), "evt_01", { criterionId: crit("innovation"), reason })).toMatchObject({ changed: false });
    setTieBreak(organizer(), "evt_01", { criterionId: null, reason: "Joint places after all" });
    const rows = auditRows().filter((r) => r.action === "event.tie_break");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.after).toMatchObject({ criterion: null, reason: "Joint places after all" });
    const line = latestAudit(getDb(), "evt_01", 1, ["event.tie_break"])[0]!;
    expect(line.parts.map((p) => p.text).join("")).toContain("keep joint places");
    const settings = JSON.parse(sqlGet<{ s: string }>("SELECT settings AS s FROM events WHERE id = 'evt_01'")!.s);
    expect(settings.tieBreak).toBeUndefined();
  });

  it("refuses no session with 401 and a judge or an outsider with 403 (each audited); the organizer is the positive control", () => {
    const refusals = () => auditRows().filter((r) => r.action.startsWith("authz.")).length;
    const before = refusals();
    expectHttpError(() => setTieBreak(null, "evt_01", { criterionId: crit("quality"), reason }), 401, "unauthenticated");
    expectHttpError(() => setTieBreak(actorById("jdg_24"), "evt_01", { criterionId: crit("quality"), reason }), 403, "not_an_organizer");
    const outsider = addUser("usr_out", "out@example.org", "Out");
    expectHttpError(() => setTieBreak(outsider, "evt_01", { criterionId: crit("quality"), reason }), 403, "not_an_organizer");
    expect(refusals()).toBeGreaterThan(before);
    expect(auditRows().filter((r) => r.action === "event.tie_break")).toHaveLength(0);
    expect(setTieBreak(organizer(), "evt_01", { criterionId: crit("quality"), reason })).toMatchObject({ changed: true });
  });

  it("refuses a criterion that is not the event's with 422", () => {
    expectHttpError(() => setTieBreak(organizer(), "evt_01", { criterionId: "crit_other", reason }), 422, "invalid");
  });

  it("is frozen once results are published: 409 from the app, and the database refuses a settings write", () => {
    settleAndPublish();
    expectHttpError(() => setTieBreak(organizer(), "evt_01", { criterionId: crit("quality"), reason }), 409, "results_published");
    expect(() => sqlRun(`UPDATE events SET settings = json_set(settings, '$.tieBreak', json('{"criterionId":"x"}')) WHERE id = 'evt_01'`)).toThrow();
  });

  it("is refused in pairwise mode (409), and switching to pairwise turns it off in the same audited change", () => {
    setTieBreak(organizer(), "evt_01", { criterionId: crit("quality"), reason });
    setJudgingMode(organizer(), "evt_01", { mode: "pairwise", reason: "Too few judges for the rubric" });
    const settings = JSON.parse(sqlGet<{ s: string }>("SELECT settings AS s FROM events WHERE id = 'evt_01'")!.s);
    expect(settings.tieBreak).toBeUndefined();
    const mode = auditRows().filter((r) => r.action === "event.judging_mode").at(-1)!;
    expect(mode.before).toMatchObject({ mode: "scores", tieBreak: expect.any(String) });
    expect(mode.after).toMatchObject({ mode: "pairwise", tieBreak: null });
    expectHttpError(() => setTieBreak(organizer(), "evt_01", { criterionId: crit("quality"), reason }), 409, "pairwise_mode");
    expect(setTieBreak(organizer(), "evt_01", { criterionId: null, reason })).toMatchObject({ changed: false });
  });

  it("keeps its criterion in the rubric: removing it is refused (409) until another tie-break is chosen", () => {
    sqlRun("DELETE FROM score_items");
    setTieBreak(organizer(), "evt_01", { criterionId: crit("innovation") });
    const rubric = sqlAll<{ id: string; label: string; prompt: string; weight: number }>("SELECT id, label, prompt, weight FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position");
    const without = rubric.filter((c) => c.id !== crit("innovation"));
    expectHttpError(() => saveRubric(organizer(), "evt_01", without), 409, "tie_break_criterion");
    setTieBreak(organizer(), "evt_01", { criterionId: crit("quality") });
    expect(saveRubric(organizer(), "evt_01", without)).toMatchObject({ count: rubric.length - 1 });
  });

  it("goes with the settings a new event copies, by the copied rubric's same criterion, without its change history", () => {
    setTieBreak(organizer(), "evt_01", { criterionId: crit("innovation"), reason });
    const made = createEvent({ ...organizer(), isAdmin: true }, {
      slug: "next-month",
      details: { name: "Next Month Hack", description: "", submissionsOpenAt: "", submissionsCloseAt: "2027-05-03T18:00", judgingCloseAt: "", maxTeamSize: "4" },
      sourceEventId: "evt_01",
    });
    const settings = JSON.parse(sqlGet<{ s: string }>("SELECT settings AS s FROM events WHERE id = ?", made.id)!.s);
    const key = sqlGet<{ key: string }>("SELECT key FROM rubric_criteria WHERE id = ?", settings.tieBreak.criterionId)!;
    expect(key.key).toBe("innovation");
    expect(settings.tieBreakChanges).toBeUndefined();
  });
});
