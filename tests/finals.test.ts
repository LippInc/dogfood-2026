import { describe, expect, it } from "vitest";
import { requireEvent } from "@/server/dal/events";
import {
  addFinalist,
  closeFinals,
  finalsStandings,
  getFinals,
  getFinalsScores,
  getPanelFinals,
  openFinals,
  removeFinalist,
  roundOnePlaces,
  saveFinalsScore,
  setFinalsPanel,
} from "@/server/dal/finals";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { exportFile } from "@/server/dal/exports";
import { competitionPlaces, publishedPlaces } from "@/lib/places";
import { actorById, addUser, auditRows, count, expectHttpError, organizer, sqlAll, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The finals (JUDGING.md, "Finals"): the organizer opens a round with the top N suggested, adjusts the finalists
// (a reason when it goes against the ranking), names a panel; only panelists score, only finalists, and only their
// own scores are ever read back; closing waits for every score or a reason; publishing waits for the close and puts
// the finalists first in their track; publishing freezes all of it. An event with no finals publishes as before.

const handle = withFixtureEvent();
const event = () => requireEvent(handle().db, "evt_01");
const judges = () => sqlAll<{ id: string }>("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").map((r) => r.id);
const criteria = () => sqlAll<{ key: string; min: number; max: number }>("SELECT key, scale_min AS min, scale_max AS max FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position, key");
const all = (v: "min" | "max" | number) => Object.fromEntries(criteria().map((c) => [c.key, v === "min" ? c.min : v === "max" ? c.max : v]));
const auditOf = (action: string) => auditRows().filter((r) => r.action === action);

/** The fixture's open decisions, settled as the other publishing tests settle them. */
function settleDecisions() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
}

/** trk_01's first-round order, best first, as the suggestion reads it. */
const trackOne = () =>
  roundOnePlaces(handle().db, event())
    .filter((p) => p.trackId === "trk_01" && p.place !== null)
    .sort((a, b) => a.place! - b.place!);

function openTrackOne(n = 3) {
  const round = openFinals(organizer(), "evt_01", { track: "trk_01", n });
  const [a, b] = judges();
  setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a, b] });
  return { round, a: actorById(a!), b: actorById(b!) };
}

describe("publishedPlaces", () => {
  it("with finals and a tie-break: a finalist's own tie figure splits an exact finals tie, the rest keep theirs", () => {
    const rows = [
      { score: 3.1, tie: 4.5, finals: { score: 4.5 } },
      { score: 3.9, tie: 4.0, finals: { score: 4.5 } },
      { score: 2.9, tie: 3, finals: null },
      { score: 2.9, tie: 2, finals: null },
    ];
    expect(publishedPlaces(rows).map((p) => [p.place, p.joint])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, false],
    ]);
    // the same rows without the figures: joint places, as before
    expect(publishedPlaces(rows.map(({ tie: _t, ...r }) => r)).map((p) => [p.place, p.joint])).toEqual([
      [1, true],
      [1, true],
      [3, true],
      [3, true],
    ]);
  });

  it("without finals it is exactly competitionPlaces", () => {
    const rows = [{ score: 4 }, { score: 4 }, { score: 3 }, { score: null }];
    expect(publishedPlaces(rows)).toEqual(competitionPlaces(rows));
  });

  it("with finals: finalists by finals score (ties joint), an unscored finalist after them, then the rest counted on", () => {
    const rows = [
      { score: 3.1, finals: { score: 4.5 } },
      { score: 3.9, finals: { score: 4.5 } },
      { score: 3.5, finals: { score: 4.0 } },
      { score: 3.0, finals: { score: null } },
      { score: 2.9, finals: null },
      { score: 2.9, finals: null },
      { score: 1.0, finals: null },
    ];
    expect(publishedPlaces(rows).map((p) => [p.place, p.joint])).toEqual([
      [1, true],
      [1, true],
      [3, false],
      [4, false],
      [5, true],
      [5, true],
      [7, false],
    ]);
  });

  it("finalsStandings: the plain mean over the panel now; a score by someone off the panel, or unfinished, does not count", () => {
    const lines = [
      { projectId: "p1", judgeUserId: "a", total: 4 },
      { projectId: "p1", judgeUserId: "b", total: 2 },
      { projectId: "p1", judgeUserId: "gone", total: 1 },
      { projectId: "p2", judgeUserId: "a", total: null },
    ];
    expect(finalsStandings(["p1", "p2"], new Set(["a", "b"]), lines)).toEqual([
      // the ±: totals 4 and 2 spread by √2 (n - 1), over √2
      { projectId: "p1", score: 3, se: 1, n: 2, criteria: {} },
      { projectId: "p2", score: null, se: null, n: 0, criteria: {} },
    ]);
  });
});

describe("opening the finals and choosing the finalists", () => {
  it("suggests the top N of the track by first-round places, audited", () => {
    const top = trackOne().filter((p) => p.place! <= 3).map((p) => p.id);
    expect(top.length).toBeGreaterThanOrEqual(3);
    const round = openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
    expect([...round.finalists].sort()).toEqual([...top].sort());
    expect(sqlAll("SELECT project_id FROM finalists WHERE finals_id = ?", round.id)).toHaveLength(top.length);
    const row = auditOf("finals.open").at(-1)!;
    expect(row.targetId).toBe(round.id);
    expect(row.eventId).toBe("evt_01");
  });

  it("a second round for the same track, or one for every track, is 409 finals_exist", () => {
    openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
    expectHttpError(() => openFinals(organizer(), "evt_01", { track: "trk_01", n: 2 }), 409, "finals_exist");
    expectHttpError(() => openFinals(organizer(), "evt_01", {}), 409, "finals_exist");
    // positive control: another track opens
    expect(openFinals(organizer(), "evt_01", { track: "trk_02", n: 2 }).id).toMatch(/^fin_/);
  });

  it("only organizers: no session 401, a judge or participant 403 (audited), nothing made", () => {
    const judge = actorById(judges()[0]!);
    expectHttpError(() => openFinals(null, "evt_01", { track: "trk_01" }), 401, "unauthenticated");
    const refusals = auditOf("authz.refused").length;
    expectHttpError(() => openFinals(judge, "evt_01", { track: "trk_01" }), 403, "not_an_organizer");
    expect(auditOf("authz.refused").length).toBe(refusals + 1);
    expect(count("SELECT count(*) AS n FROM finals")).toBe(0);
    expectHttpError(() => getFinals(judge, "evt_01"), 403, "not_an_organizer");
    expectHttpError(() => getFinals(null, "evt_01"), 401, "unauthenticated");
    expect(getFinals(organizer(), "evt_01").rounds).toEqual([]);
  });

  it("adding a finalist outside the top N needs a reason; with it the reason is stored and audited", () => {
    const { round } = openTrackOne(2);
    const outside = trackOne().find((p) => p.place! > 2)!;
    expectHttpError(() => addFinalist(organizer(), "evt_01", round.id, { project: outside.id }), 422, "invalid");
    addFinalist(organizer(), "evt_01", round.id, { project: outside.id, reason: "The judges asked to see it again" });
    expect(sqlAll<{ reason: string }>("SELECT reason FROM finalists WHERE finals_id = ? AND project_id = ?", round.id, outside.id)[0]!.reason).toBe(
      "The judges asked to see it again",
    );
    expect(auditOf("finals.finalist_add").at(-1)!.after).toMatchObject({ project: outside.id, reason: "The judges asked to see it again" });
    expectHttpError(() => addFinalist(actorById(judges()[0]!), "evt_01", round.id, { project: outside.id }), 403, "not_an_organizer");
  });

  it("taking off a top-N finalist needs a reason; an added one does not", () => {
    const { round } = openTrackOne(3);
    const inTop = round.finalists[0]!;
    expectHttpError(() => removeFinalist(organizer(), "evt_01", round.id, inTop, {}), 422, "invalid");
    removeFinalist(organizer(), "evt_01", round.id, inTop, { reason: "Withdrew from the final" });
    expect(auditOf("finals.finalist_remove").at(-1)!.after).toMatchObject({ reason: "Withdrew from the final" });
    const outside = trackOne().find((p) => p.place! > 3)!;
    addFinalist(organizer(), "evt_01", round.id, { project: outside.id, reason: "Next in line" });
    removeFinalist(organizer(), "evt_01", round.id, outside.id, {});
    expect(sqlAll("SELECT 1 FROM finalists WHERE finals_id = ? AND project_id = ?", round.id, outside.id)).toHaveLength(0);
  });

  it("the panel: at least two of the event's judges; anyone else is 422", () => {
    const round = openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
    const [a, b] = judges();
    expectHttpError(() => setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a] }), 422, "invalid");
    expectHttpError(() => setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a, a] }), 422, "invalid");
    const stranger = addUser("usr_stranger", "stranger@example.org", "Stranger");
    expectHttpError(() => setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a, stranger.userId] }), 422, "invalid");
    expect(setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a, b] })).toMatchObject({ changed: true });
    expect(auditOf("finals.panel").at(-1)!.after).toEqual({ panel: [a, b].sort() });
    expect(setFinalsPanel(organizer(), "evt_01", round.id, { judges: [b, a] })).toMatchObject({ changed: false });
  });
});

describe("every organizer finals write: 401 without a session, 403 (audited) for a judge, and the organizer's call goes through", () => {
  it("add, take off, panel and close", () => {
    const { round } = openTrackOne(3);
    const judge = actorById(judges()[0]!);
    const outside = trackOne().find((p) => p.place! > 3)!.id;
    const calls: [string, (a: ReturnType<typeof organizer> | null) => unknown][] = [
      ["add", (a) => addFinalist(a, "evt_01", round.id, { project: outside, reason: "Asked back by the jury" })],
      ["take off", (a) => removeFinalist(a, "evt_01", round.id, outside, {})],
      ["panel", (a) => setFinalsPanel(a, "evt_01", round.id, { judges: judges().slice(1, 3) })],
      ["close", (a) => closeFinals(a, "evt_01", round.id, { reason: "Out of time for the rest" })],
    ];
    for (const [what, call] of calls) {
      expectHttpError(() => call(null), 401, "unauthenticated");
      const refusals = auditOf("authz.refused").length;
      expectHttpError(() => call(judge), 403, "not_an_organizer");
      expect(auditOf("authz.refused").length, what).toBe(refusals + 1);
      expect(() => call(organizer()), what).not.toThrow();
    }
    expect(sqlAll<{ closed_at: string | null }>("SELECT closed_at FROM finals WHERE id = ?", round.id)[0]!.closed_at).not.toBeNull();
  });
});

describe("panel scoring and isolation", () => {
  it("a panelist scores a finalist; a judge off the panel is 403 not_on_the_panel; no session 401", () => {
    const { round, a } = openTrackOne();
    const other = actorById(judges()[2]!);
    const project = round.finalists[0]!;
    expectHttpError(() => saveFinalsScore(null, "evt_01", { finals: round.id, project, values: all("max") }), 401, "unauthenticated");
    expectHttpError(() => saveFinalsScore(other, "evt_01", { finals: round.id, project, values: all("max") }), 403, "not_on_the_panel");
    expect(count("SELECT count(*) AS n FROM finals_scores")).toBe(0);
    // positive control
    const saved = saveFinalsScore(a, "evt_01", { finals: round.id, project, values: all("max") });
    expect(saved.project).toBe(project);
    expect(auditOf("finals.score").at(-1)!.actorUserId).toBe(a.userId);
  });

  it("only finalists: another project of the event is 403 not_a_finalist", () => {
    const { round, a } = openTrackOne();
    const notFinalist = trackOne().find((p) => !round.finalists.includes(p.id))!.id;
    expectHttpError(() => saveFinalsScore(a, "evt_01", { finals: round.id, project: notFinalist, values: all("max") }), 403, "not_a_finalist");
  });

  it("every criterion, on its scale: a missing or out-of-scale value is 422 and nothing is stored", () => {
    const { round, a } = openTrackOne();
    const project = round.finalists[0]!;
    const [first] = criteria();
    const { [first!.key]: _drop, ...partial } = all("max");
    expectHttpError(() => saveFinalsScore(a, "evt_01", { finals: round.id, project, values: partial }), 422, "invalid");
    expectHttpError(() => saveFinalsScore(a, "evt_01", { finals: round.id, project, values: { ...all("max"), [first!.key]: first!.max + 1 } }), 422, "invalid");
    expect(count("SELECT count(*) AS n FROM finals_scores")).toBe(0);
  });

  it("a panelist reads only their own finals scores: another panelist's id is 403, their own id 200 with only their rows", () => {
    const { round, a, b } = openTrackOne();
    const project = round.finalists[0]!;
    saveFinalsScore(a, "evt_01", { finals: round.id, project, values: all("max") });
    saveFinalsScore(b, "evt_01", { finals: round.id, project, values: all("min") });
    expectHttpError(() => getFinalsScores(a, "evt_01", b.userId), 403, "not_your_scores");
    expectHttpError(() => getPanelFinals(a, "evt_01", b.userId), 403, "not_your_scores");
    const own = getFinalsScores(a, "evt_01", a.userId);
    expect(own.judge.id).toBe(a.userId);
    expect(own.scores).toHaveLength(1);
    expect(own.scores[0]!.values).toEqual(all("max"));
    // the panel view carries no other panelist's figures
    expect(JSON.stringify(getPanelFinals(a, "evt_01"))).not.toContain(b.userId);
    // a judge on no panel has no finals to read
    expectHttpError(() => getFinalsScores(actorById(judges()[2]!), "evt_01"), 403, "not_on_the_panel");
    expectHttpError(() => getFinalsScores(null, "evt_01"), 401, "unauthenticated");
  });
});

describe("closing, publishing and the freeze", () => {
  function scoreAll(round: { id: string; finalists: string[] }, panel: ReturnType<typeof actorById>[], valueOf: (project: string) => number) {
    for (const j of panel) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all(valueOf(p)) });
  }

  it("closing with a score missing is 409 finals_incomplete; with a reason it closes, and scoring is then 403 finals_closed", () => {
    const { round, a } = openTrackOne();
    saveFinalsScore(a, "evt_01", { finals: round.id, project: round.finalists[0]!, values: all("max") });
    expectHttpError(() => closeFinals(organizer(), "evt_01", round.id, {}), 409, "finals_incomplete");
    closeFinals(organizer(), "evt_01", round.id, { reason: "One panelist fell ill" });
    expect(auditOf("finals.close").at(-1)!.after).toMatchObject({ reason: "One panelist fell ill" });
    expectHttpError(() => saveFinalsScore(a, "evt_01", { finals: round.id, project: round.finalists[1]!, values: all("max") }), 403, "finals_closed");
    expectHttpError(() => addFinalist(organizer(), "evt_01", round.id, { project: trackOne().at(-1)!.id, reason: "late" }), 409, "finals_closed");
  });

  it("publishing waits for the close; then the finalists lead their track in the finals order and the rest follow in first-round order", () => {
    settleDecisions();
    const { round, a, b } = openTrackOne();
    // the finals reverse the first round's order among the finalists
    const firstRound = trackOne().map((p) => p.id);
    const finalistsBest = firstRound.filter((id) => round.finalists.includes(id));
    const reversed = [...finalistsBest].reverse();
    const scale = criteria()[0]!;
    scoreAll(round, [a, b], (p) => scale.max - reversed.indexOf(p));
    expectHttpError(() => publishResults(organizer(), "evt_01"), 409, "finals_open");
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    expect(results.finals).toEqual([expect.objectContaining({ trackId: "trk_01", panel: 2, finalists: round.finalists.length, closeReason: null })]);
    const t1 = results.tracks.find((t) => t.id === "trk_01")!;
    const order = t1.rows.map((r) => r.projectId);
    expect(order.slice(0, reversed.length)).toEqual(reversed);
    expect(order.slice(reversed.length)).toEqual(firstRound.filter((id) => !round.finalists.includes(id)).filter((id) => order.includes(id)));
    expect(t1.rows.slice(0, reversed.length).map((r) => r.place)).toEqual(reversed.map((_, i) => i + 1));
    expect(t1.rows[reversed.length]!.place).toBe(reversed.length + 1);
    expect(t1.rows[0]!.finals).toMatchObject({ n: 2 });
    expect(t1.rows.at(-1)!.finals ?? null).toBeNull();
    // another track is as it was: no finals key on its rows
    const t2 = results.tracks.find((t) => t.id === "trk_02")!;
    expect(t2.rows.every((r) => !("finals" in r))).toBe(true);
    // the certificate's award follows the published place
    expect(publishedPlaces(t1.rows)[0]!.place).toBe(1);
  });

  it("frozen by publishing: the app refuses and the database refuses an insert, update or delete", () => {
    settleDecisions();
    const { round, a, b } = openTrackOne();
    scoreAll(round, [a, b], () => criteria()[0]!.max);
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    expectHttpError(() => openFinals(organizer(), "evt_01", { track: "trk_02" }), 409, "results_published");
    expectHttpError(() => setFinalsPanel(organizer(), "evt_01", round.id, { judges: judges().slice(0, 3) }), 409, "results_published");
    expect(() => sqlRun("UPDATE finals SET close_reason = 'x' WHERE id = ?", round.id)).toThrow(/results are published/);
    expect(() => sqlRun("DELETE FROM finalists WHERE finals_id = ?", round.id)).toThrow(/results are published/);
    expect(() => sqlRun("DELETE FROM finals_panel WHERE finals_id = ?", round.id)).toThrow(/results are published/);
    expect(() => sqlRun("UPDATE finals_score_items SET value = value")).toThrow(/results are published/);
    expect(() => sqlRun("DELETE FROM finals_scores")).toThrow(/results are published/);
    expect(() =>
      sqlRun("INSERT INTO finalists (finals_id, event_id, project_id, reason, added_at, added_by) VALUES (?, 'evt_01', 'prj_02', NULL, '2026-09-29T00:00:00.000Z', 'usr_organizer')", round.id),
    ).toThrow(/nothing can be added/);
  });

  it("a finals score off its criterion's scale is refused by the database too", () => {
    const { round, a } = openTrackOne();
    saveFinalsScore(a, "evt_01", { finals: round.id, project: round.finalists[0]!, values: all("max") });
    expect(() => sqlRun("UPDATE finals_score_items SET value = 1000")).toThrow(/outside its criterion/);
  });

  it("finals.csv and event.json carry the finals; the audit log names every step", () => {
    const { round, a, b } = openTrackOne();
    scoreAll(round, [a, b], () => criteria()[0]!.max);
    closeFinals(organizer(), "evt_01", round.id, {});
    const csv = exportFile(organizer(), "evt_01", "finals.csv").body;
    const lines = csv.trim().split(/\r?\n/);
    expect(lines[0]).toMatch(/^finals_id,finals_track,closed_at/);
    expect(lines).toHaveLength(1 + round.finalists.length * 3);
    const json = JSON.parse(exportFile(organizer(), "evt_01", "event.json").body) as { finals?: { finals: unknown[]; scores: unknown[] } };
    expect(json.finals?.finals).toHaveLength(1);
    expect(json.finals?.scores).toHaveLength(round.finalists.length * 2);
    expectHttpError(() => exportFile(a, "evt_01", "finals.csv"), 403, "not_an_organizer");
  });
});

describe("an event with no finals is published exactly as before", () => {
  it("no finals key anywhere, places as competitionPlaces, finals.csv only its header, event.json without finals", () => {
    settleDecisions();
    publishResults(organizer(), "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    expect(JSON.stringify(results)).not.toContain("finals");
    expect(Object.keys(results)).not.toContain("finals");
    for (const t of results.tracks) expect(publishedPlaces(t.rows)).toEqual(competitionPlaces(t.rows));
    expect(exportFile(organizer(), "evt_01", "finals.csv").body.trim().split(/\r?\n/)).toHaveLength(1);
    expect(exportFile(organizer(), "evt_01", "event.json").body).not.toContain('"finals"');
  });
});
