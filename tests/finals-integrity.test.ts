import { describe, expect, it } from "vitest";
import { requireEvent } from "@/server/dal/events";
import { closeFinals, getFinals, openFinals, roundOnePlaces, saveFinalsScore, setFinalsPanel } from "@/server/dal/finals";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { removeJudge } from "@/server/dal/corrections";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { exportFile } from "@/server/dal/exports";
import { payloadFor } from "@/server/webhooks";
import { publishedPlaces } from "@/lib/places";
import { actorById, auditRows, count, expectHttpError, organizer, sqlAll, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The review's integrity findings on the finals (2026-09-29): conflicts of interest hold in the finals, a panel change
// after scoring needs a reason the results show, a removed or left-out judge's finals scores stop counting, opening
// the finals leaks no first-round places to webhooks, normalized.csv's track_place is the published place, and a
// pairwise event cannot open finals.

const handle = withFixtureEvent();
const event = () => requireEvent(handle().db, "evt_01");
const judges = () => sqlAll<{ id: string }>("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").map((r) => r.id);
const criteria = () => sqlAll<{ key: string; min: number; max: number }>("SELECT key, scale_min AS min, scale_max AS max FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position, key");
const all = (v: number | "max" | "min") => Object.fromEntries(criteria().map((c) => [c.key, v === "min" ? c.min : v === "max" ? c.max : v]));
const auditOf = (action: string) => auditRows().filter((r) => r.action === action);

function settleDecisions() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
}

/** A panel of three judges on trk_01's top 3, none of them jdg_07 (the fixture's flagged judge). */
function openPanel() {
  const round = openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
  const [a, b, c] = judges().filter((j) => j !== "jdg_07");
  setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a!, b!, c!] });
  return { round, a: actorById(a!), b: actorById(b!), c: actorById(c!) };
}

function joinTeamOf(projectId: string, userId: string) {
  sqlRun(
    "INSERT INTO team_members (event_id, team_id, user_id, role, joined_at) SELECT event_id, team_id, ?, 'member', '2026-09-20T10:00:00.000Z' FROM projects WHERE id = ?",
    userId,
    projectId,
  );
}

function recuse(projectId: string, userId: string) {
  const has = sqlAll("SELECT 1 FROM assignments WHERE judge_user_id = ? AND project_id = ?", userId, projectId).length > 0;
  if (has) sqlRun("UPDATE assignments SET status = 'recused' WHERE judge_user_id = ? AND project_id = ?", userId, projectId);
  else
    sqlRun(
      "INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, batch_no, position, status, created_at) SELECT 'asg_test_recused', event_id, ?, ?, run_id, 1, 0, 'recused', created_at FROM assignments WHERE event_id = 'evt_01' LIMIT 1",
      userId,
      projectId,
    );
}

describe("conflicts of interest hold in the finals", () => {
  it("a panelist on the finalist's team is 403 own_team (audited); the same panelist scores another finalist", () => {
    const { round, a } = openPanel();
    const [mine, other] = round.finalists;
    joinTeamOf(mine!, a.userId);
    const refusals = auditOf("authz.refused").length;
    expectHttpError(() => saveFinalsScore(a, "evt_01", { finals: round.id, project: mine!, values: all("max") }), 403, "own_team");
    expect(auditOf("authz.refused").length).toBe(refusals + 1);
    expect(count("SELECT count(*) AS n FROM finals_scores")).toBe(0);
    // positive control
    expect(saveFinalsScore(a, "evt_01", { finals: round.id, project: other!, values: all("max") }).project).toBe(other);
  });

  it("a conflict declared in the first round (recused) is 403 recused in the finals; another finalist is fine", () => {
    const { round, b } = openPanel();
    const [first, second] = round.finalists;
    recuse(first!, b.userId);
    expectHttpError(() => saveFinalsScore(b, "evt_01", { finals: round.id, project: first!, values: all("max") }), 403, "recused");
    expect(saveFinalsScore(b, "evt_01", { finals: round.id, project: second!, values: all("max") }).project).toBe(second);
  });

  it("closing does not wait for a conflicted pair, and the Finals tab names the conflict", () => {
    const { round, a, b, c } = openPanel();
    const [mine] = round.finalists;
    joinTeamOf(mine!, a.userId);
    for (const j of [a, b, c]) for (const p of round.finalists) if (!(j === a && p === mine)) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    const view = getFinals(organizer(), "evt_01").rounds[0]!;
    expect(view.missing).toBe(0);
    const pa = view.panel.find((p) => p.id === a.userId)!;
    expect(pa.conflicts).toEqual([expect.objectContaining({ why: "own_team" })]);
    expect(pa.toScore).toBe(round.finalists.length - 1);
    // closes with no reason: nothing is missing
    expect(closeFinals(organizer(), "evt_01", round.id, {}).missing).toBe(0);
  });

  it("without the conflict the same pair is waited for (the control)", () => {
    const { round, a, b, c } = openPanel();
    const [mine] = round.finalists;
    for (const j of [a, b, c]) for (const p of round.finalists) if (!(j === a && p === mine)) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    expect(getFinals(organizer(), "evt_01").rounds[0]!.missing).toBe(1);
    expectHttpError(() => closeFinals(organizer(), "evt_01", round.id, {}), 409, "finals_incomplete");
  });
});

describe("a panel change after scoring", () => {
  it("needs a written reason once any finals score exists, kept in the audit row and shown on the published results", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    expectHttpError(() => setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a.userId, b.userId] }), 422, "invalid");
    expect(sqlAll("SELECT judge_user_id FROM finals_panel WHERE finals_id = ?", round.id)).toHaveLength(3);
    setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a.userId, b.userId], reason: "Third panelist left early" });
    expect(auditOf("finals.panel").at(-1)!.after).toMatchObject({ reason: "Third panelist left early" });
    expect(getFinals(organizer(), "evt_01").rounds[0]!.panelChanges).toEqual([expect.objectContaining({ reason: "Third panelist left early", removed: 1, added: 0 })]);
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    expect(r.finals![0]!.panelChanges).toEqual([expect.objectContaining({ reason: "Third panelist left early" })]);
  });

  it("before any score, the panel changes with no reason (the control)", () => {
    const { round, a, b } = openPanel();
    expect(setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a.userId, b.userId] })).toMatchObject({ changed: true });
    expect(auditOf("finals.panel").at(-1)!.after).toEqual({ panel: [a.userId, b.userId].sort() });
  });
});

describe("a removed or left-out judge's finals scores leave the finals order", () => {
  function scoreSplit(round: { id: string; finalists: string[] }, a: ReturnType<typeof actorById>, others: ReturnType<typeof actorById>[]) {
    // a alone puts the last finalist first; the others agree on the first-round order
    const scale = criteria()[0]!;
    round.finalists.forEach((p, i) => {
      saveFinalsScore(a, "evt_01", { finals: round.id, project: p, values: all(i === round.finalists.length - 1 ? scale.max : scale.min) });
      for (const o of others) saveFinalsScore(o, "evt_01", { finals: round.id, project: p, values: all(i === round.finalists.length - 1 ? scale.min + 1 : scale.min + 1) });
    });
  }

  it("left out (judge.override exclude): the standings count the others only, and the Finals tab says so by name", () => {
    const { round, a, b, c } = openPanel();
    scoreSplit(round, a, [b, c]);
    const before = getFinals(organizer(), "evt_01").rounds[0]!.finalists.find((f) => f.projectId === round.finalists.at(-1))!;
    expect(before.n).toBe(3);
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: a.userId, mode: "exclude", reason: "Scored the finals at random" });
    const view = getFinals(organizer(), "evt_01").rounds[0]!;
    const after = view.finalists.find((f) => f.projectId === round.finalists.at(-1))!;
    expect(after.n).toBe(2);
    expect(view.panel.find((p) => p.id === a.userId)).toMatchObject({ out: "left_out", name: expect.any(String) });
    // and nobody waits for a left-out panelist
    expect(view.missing).toBe(0);
  });

  it("removed from the judges (judge.remove): out of the order, still named on the Finals tab", () => {
    const { round, a, b, c } = openPanel();
    scoreSplit(round, a, [b, c]);
    removeJudge(organizer(), "evt_01", a.userId, { reason: "Turned out to mentor a finalist" });
    const view = getFinals(organizer(), "evt_01").rounds[0]!;
    expect(view.finalists.every((f) => f.n === 2)).toBe(true);
    const pa = view.panel.find((p) => p.id === a.userId)!;
    expect(pa.out).toBe("removed");
    expect(pa.name).not.toBe(a.userId);
    // the scores stay on record
    expect(count("SELECT count(*) AS n FROM finals_scores WHERE judge_user_id = ?", a.userId)).toBe(round.finalists.length);
  });

  it("a panelist neither removed nor left out counts (the control)", () => {
    const { round, a, b, c } = openPanel();
    scoreSplit(round, a, [b, c]);
    const view = getFinals(organizer(), "evt_01").rounds[0]!;
    expect(view.finalists.every((f) => f.n === 3)).toBe(true);
    expect(view.panel.every((p) => p.out === null)).toBe(true);
  });
});

describe("webhooks never carry the unpublished first-round places of a finals opening", () => {
  it("the finals.open delivery keeps the track and N, never the finalists' places", () => {
    openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
    const row = auditOf("finals.open").at(-1)!;
    // the log itself holds the places (the control: there is something to seal)
    expect(JSON.stringify(row.after)).toContain("place");
    const body = payloadFor("dlv_test", row as Parameters<typeof payloadFor>[1], "sample-hack-2026") as { data: { after: Record<string, unknown> | null } };
    expect(body.data.after).toEqual({ track: "trk_01", n: 3 });
    expect(JSON.stringify(body)).not.toContain("place");
  });
});

describe("normalized.csv and the results API after finals", () => {
  it("track_place is the published place, finals_score the finalist's; the API's place is the same place", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    const firstRound = roundOnePlaces(handle().db, event())
      .filter((p) => p.trackId === "trk_01" && p.place !== null)
      .sort((x, y) => x.place! - y.place!)
      .map((p) => p.id);
    const finalistsBest = firstRound.filter((id) => round.finalists.includes(id));
    const reversed = [...finalistsBest].reverse();
    const scale = criteria()[0]!;
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all(scale.max - reversed.indexOf(p)) });
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const r = getPublishedResults("evt_01");
    if (!r.published) throw new Error("not published");
    const t1 = r.tracks.find((t) => t.id === "trk_01")!;
    const shown = publishedPlaces(t1.rows);
    const csv = exportFile(organizer(), "evt_01", "normalized.csv").body.trim().split(/\r?\n/);
    const head = csv[0]!.split(",");
    expect(head.slice(-2)).toEqual(["track_place", "finals_score"]);
    // the stage columns are the last two: read them from the end, whatever a quoted title holds
    const at = (id: string) => {
      const [place, score] = csv.find((l) => l.startsWith(`${id},`))!.split(",").slice(-2);
      return { place: place!, score: score! };
    };
    t1.rows.forEach((row, i) => {
      if (shown[i]!.place === null) return;
      expect(Number(at(row.projectId).place)).toBe(shown[i]!.place);
      // no joint places here, so the API's place is the same whole number
      if (!shown[i]!.joint) expect(row.place).toBe(shown[i]!.place);
    });
    // the finals reversed the first round, so the published first is the first round's last finalist
    expect(Number(at(reversed[0]!).place)).toBe(1);
    expect(at(reversed[0]!).score).not.toBe("");
  });

  it("with no finals, normalized.csv has no track_place or finals_score column (the control)", () => {
    settleDecisions();
    publishResults(organizer(), "evt_01");
    const head = exportFile(organizer(), "evt_01", "normalized.csv").body.split(/\r?\n/)[0]!.split(",");
    expect(head).not.toContain("finals_score");
    expect(head).not.toContain("track_place");
  });
});

describe("a pairwise event cannot open finals", () => {
  it("409 pairwise_mode, nothing made; the same event in scores mode opens (the control)", () => {
    sqlRun("UPDATE events SET settings = json_set(settings, '$.judgingMode', 'pairwise') WHERE id = 'evt_01'");
    expectHttpError(() => openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 }), 409, "pairwise_mode");
    expect(count("SELECT count(*) AS n FROM finals")).toBe(0);
    sqlRun("UPDATE events SET settings = json_set(settings, '$.judgingMode', 'scores') WHERE id = 'evt_01'");
    expect(openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 }).id).toMatch(/^fin_/);
  });
});
