import { describe, expect, it } from "vitest";
import { tieBrokenByOf } from "@/components/results/after-the-fact";
import { overallOrder } from "@/lib/overall";
import { publishedPlaces } from "@/lib/places";
import { setJudgeOverride, acceptUnderReviewed, mergeDuplicate } from "@/server/dal/decisions";
import { requireEvent } from "@/server/dal/events";
import { exportFile } from "@/server/dal/exports";
import {
  addFinalist,
  closeFinals,
  finalsTrackIds,
  getPanelFinals,
  openFinals,
  removeFinalist,
  roundOnePlaces,
  saveFinalsScore,
  setFinalsPanel,
  standardError,
} from "@/server/dal/finals";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { setTieBreak } from "@/server/dal/tiebreak";
import { actorById, expectHttpError, organizer, sqlAll, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The finals' third pass (2026-09-29): a ± on every finals score, the finalists changed against the ranking shown with
// their reasons, the overall order's track places after the finals, a panel no single judge can decide, the panelist
// told what they cannot score, finals.csv's place the published one, and the tracks a finals round decides.

const handle = withFixtureEvent();
const event = () => requireEvent(handle().db, "evt_01");
const judges = () => sqlAll<{ id: string }>("SELECT user_id AS id FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' ORDER BY user_id").map((r) => r.id);
type Crit = { id: string; key: string; weight: number; min: number; max: number };
const criteria = () => sqlAll<Crit>("SELECT id, key, weight, scale_min AS min, scale_max AS max FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position, key");
const all = (v: number | "max" | "min") => Object.fromEntries(criteria().map((c) => [c.key, v === "min" ? c.min : v === "max" ? c.max : v]));

function settleDecisions() {
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
}

function openPanel(track: string | null = "trk_01") {
  const round = openFinals(organizer(), "evt_01", track ? { track, n: 3 } : { n: 3 });
  const [a, b, c] = judges().filter((j) => j !== "jdg_07");
  setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a!, b!, c!] });
  return { round, a: actorById(a!), b: actorById(b!), c: actorById(c!) };
}

const published = () => {
  const r = getPublishedResults("evt_01");
  if (!r.published) throw new Error("not published");
  return r;
};

describe("the ± on a finals score", () => {
  it("standardError: the sample spread over √n, none below two totals", () => {
    expect(standardError([])).toBeNull();
    expect(standardError([4])).toBeNull();
    expect(standardError([3, 5])).toBeCloseTo(1, 12);
    // sd of 2, 4, 6 is 2 (n - 1), so 2 / √3
    expect(standardError([2, 4, 6])).toBeCloseTo(2 / Math.sqrt(3), 12);
    expect(standardError([4, 4, 4])).toBe(0);
  });

  it("the published finalist carries it, finals.csv writes it, and one panelist's score carries none", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    const [p, q] = round.finalists;
    // p gets min, mid, max: a real spread; q only one panelist's score
    const lo = criteria()[0]!;
    saveFinalsScore(a, "evt_01", { finals: round.id, project: p!, values: all("min") });
    saveFinalsScore(b, "evt_01", { finals: round.id, project: p!, values: all(Math.round((lo.min + lo.max) / 2)) });
    saveFinalsScore(c, "evt_01", { finals: round.id, project: p!, values: all("max") });
    saveFinalsScore(a, "evt_01", { finals: round.id, project: q!, values: all("max") });
    closeFinals(organizer(), "evt_01", round.id, { reason: "Two panelists had to leave" });
    publishResults(organizer(), "evt_01");
    const rows = published().tracks.find((t) => t.id === "trk_01")!.rows;
    const fp = rows.find((r) => r.projectId === p)!.finals!;
    const csv = exportFile(organizer(), "evt_01", "finals.csv").body.trim().split(/\r?\n/);
    const head = csv[0]!.split(",");
    const at = (name: string, line: string[]) => line[head.indexOf(name)];
    const summary = (id: string) => csv.map((l) => l.split(",")).find((l) => at("project_id", l) === id && at("score_id", l) === "")!;
    const totals = csv.map((l) => l.split(",")).filter((l) => at("project_id", l) === p && at("score_id", l) !== "").map((l) => Number(at("total", l)));
    expect(totals).toHaveLength(3);
    expect(fp.n).toBe(3);
    expect(fp.se).not.toBeNull();
    expect(fp.se!).toBeCloseTo(standardError(totals)!, 9);
    expect(fp.se!).toBeGreaterThan(0);
    expect(Number(at("finals_se", summary(p!)))).toBeCloseTo(fp.se!, 9);
    const fq = rows.find((r) => r.projectId === q)!.finals!;
    expect([fq.n, fq.se]).toEqual([1, null]);
    expect(at("finals_se", summary(q!))).toBe("");
  });
});

describe("finalists changed against the ranking are on the published results with their reasons", () => {
  it("an added outsider and a top-N finalist taken off, each with its reason; a plain round lists none (the control)", () => {
    settleDecisions();
    const { round, a, b } = openPanel();
    const outsider = roundOnePlaces(handle().db, event()).find((p) => p.trackId === "trk_01" && p.place !== null && p.place > 3)!;
    addFinalist(organizer(), "evt_01", round.id, { project: outsider.id, reason: "Best demo on the day" });
    const dropped = round.finalists[2]!;
    removeFinalist(organizer(), "evt_01", round.id, dropped, { reason: "Broke the code of conduct" });
    const now = [round.finalists[0]!, round.finalists[1]!, outsider.id];
    for (const j of [a, b]) for (const p of now) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a.userId, b.userId], reason: "Third panelist did not score" });
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const changes = published().finals![0]!.finalistChanges;
    expect(changes).toEqual([
      expect.objectContaining({ projectId: outsider.id, change: "added", reason: "Best demo on the day" }),
      expect.objectContaining({ projectId: dropped, change: "removed", reason: "Broke the code of conduct" }),
    ]);
  });

  it("a round of the ranking's own finalists has no finalist changes", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    expect(published().finals![0]!.finalistChanges).toEqual([]);
  });
});

/** Scores the finalists so the finals reverse the first round; returns the first round's finalists best first. */
function reverseFinals(round: { id: string; finalists: string[] }, panel: ReturnType<typeof actorById>[]) {
  const firstRound = roundOnePlaces(handle().db, event())
    .filter((p) => round.finalists.includes(p.id) && p.place !== null)
    .sort((x, y) => x.place! - y.place!)
    .map((p) => p.id);
  const scale = criteria()[0]!;
  for (const j of panel) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all(scale.min + firstRound.indexOf(p)) });
  return firstRound;
}

describe("the overall order's track places after the finals", () => {
  it("names the finals winner 1st in its track, as the track page does, marked as the finals' place", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    const firstRound = reverseFinals(round, [a, b, c]);
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const r = published();
    const winner = firstRound.at(-1)!;
    const t1 = r.tracks.find((t) => t.id === "trk_01")!;
    expect(publishedPlaces(t1.rows)[t1.rows.findIndex((x) => x.projectId === winner)]!.place).toBe(1);
    const entry = overallOrder(r.tracks).find((e) => e.row.projectId === winner)!;
    expect(entry.trackPlace).toEqual({ place: 1, joint: false, finals: true });
    // every entry's track place is the track page's
    for (const t of r.tracks) {
      const places = publishedPlaces(t.rows);
      t.rows.forEach((row, i) => {
        const e = overallOrder(r.tracks).find((x) => x.row.projectId === row.projectId);
        if (e) expect(e.trackPlace.place).toBe(places[i]!.place);
      });
    }
  });

  it("equal finals scores: the finalists are joint 1st in their track on the overall order too, as on the track page", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const r = published();
    const entries = overallOrder(r.tracks).filter((e) => round.finalists.includes(e.row.projectId));
    expect(entries).toHaveLength(round.finalists.length);
    for (const e of entries) expect(e.trackPlace).toEqual({ place: 1, joint: true, finals: true });
  });

  it("without finals no place is marked as the finals' (the control)", () => {
    settleDecisions();
    publishResults(organizer(), "evt_01");
    expect(overallOrder(published().tracks).every((e) => e.trackPlace.finals === false)).toBe(true);
  });
});

describe("no single judge decides the finals", () => {
  it("a judge left out of the ranking cannot join a panel (409 judge_left_out); a counted judge can (the control)", () => {
    const { round, a, b } = openPanel();
    const [, , , d, e] = judges().filter((j) => j !== "jdg_07");
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: d!, mode: "exclude", reason: "Scored at random" });
    expectHttpError(() => setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a.userId, b.userId, d!] }), 409, "judge_left_out");
    expect(sqlAll("SELECT judge_user_id FROM finals_panel WHERE finals_id = ?", round.id)).toHaveLength(3);
    expect(setFinalsPanel(organizer(), "evt_01", round.id, { judges: [a.userId, b.userId, e!] })).toMatchObject({ changed: true });
  });

  it("closing with one counted panelist is 409 too_few_counted; with a reason it closes and the results do not say every panelist", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: b.userId, mode: "exclude", reason: "Mentored a finalist" });
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: c.userId, mode: "exclude", reason: "Mentored a finalist" });
    expectHttpError(() => closeFinals(organizer(), "evt_01", round.id, {}), 409, "too_few_counted");
    expect(sqlAll<{ closed_at: string | null }>("SELECT closed_at FROM finals WHERE id = ?", round.id)[0]!.closed_at).toBeNull();
    closeFinals(organizer(), "evt_01", round.id, { reason: "Both mentored a finalist; no time to replace them" });
    publishResults(organizer(), "evt_01");
    const f = published().finals![0]!;
    expect([f.panel, f.missing, f.closeReason]).toEqual([1, 0, "Both mentored a finalist; no time to replace them"]);
  });

  it("two counted panelists close with no reason (the control)", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: c.userId, mode: "exclude", reason: "Mentored a finalist" });
    expect(closeFinals(organizer(), "evt_01", round.id, {})).toMatchObject({ missing: 0 });
  });
});

describe("a panelist is told what they cannot score and whether their scores count", () => {
  it("a finalist of their own team or one they recused from carries its conflict; the others none", () => {
    const { round, a } = openPanel();
    const [mine, recused, free] = round.finalists;
    sqlRun(
      "INSERT INTO team_members (event_id, team_id, user_id, role, joined_at) SELECT event_id, team_id, ?, 'member', '2026-09-20T10:00:00.000Z' FROM projects WHERE id = ?",
      a.userId,
      mine!,
    );
    sqlRun(
      "INSERT INTO assignments (id, event_id, judge_user_id, project_id, run_id, batch_no, position, status, created_at) SELECT 'asg_test_recused3', event_id, ?, ?, run_id, 1, 0, 'recused', created_at FROM assignments WHERE event_id = 'evt_01' LIMIT 1",
      a.userId,
      recused!,
    );
    const v = getPanelFinals(a, "evt_01");
    const of = (id: string) => v.rounds[0]!.finalists.find((f) => f.projectId === id)!.conflict;
    expect([of(mine!), of(recused!), of(free!)]).toEqual(["own_team", "recused", null]);
    expect(v.out).toBeNull();
  });

  it("a left-out panelist is told their scores do not count; a counted one is not (the control)", () => {
    const { a, b } = openPanel();
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: a.userId, mode: "exclude", reason: "Scored at random" });
    expect(getPanelFinals(a, "evt_01").out).toBe("left_out");
    expect(getPanelFinals(b, "evt_01").out).toBeNull();
  });
});

describe("finals.csv's place is the published place", () => {
  it("in a round over every track, each finalist's place is its place in its own track", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel(null);
    for (const j of [a, b, c]) for (const p of round.finalists) saveFinalsScore(j, "evt_01", { finals: round.id, project: p, values: all("max") });
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const r = published();
    const place = new Map<string, number | null>();
    for (const t of r.tracks) publishedPlaces(t.rows).forEach((p, i) => place.set(t.rows[i]!.projectId, p.place));
    const csv = exportFile(organizer(), "evt_01", "finals.csv").body.trim().split(/\r?\n/).map((l) => l.split(","));
    const head = csv[0]!;
    const rows = csv.slice(1).filter((l) => l[head.indexOf("score_id")] === "");
    expect(rows.length).toBe(round.finalists.length);
    for (const l of rows) expect(Number(l[head.indexOf("finals_place")])).toBe(place.get(l[head.indexOf("project_id")]!));
    // every finalist scored the same, so each track's finalists share its 1st place, never a place across tracks
    expect(new Set(rows.map((l) => l[head.indexOf("finals_place")]))).toEqual(new Set(["1"]));
  });
});

/** Two finalists of trk_01 tied exactly in the finals but apart on one criterion (two criteria of equal weight swapped). */
function plantFinalsTie(round: { id: string; finalists: string[] }, panel: ReturnType<typeof actorById>[]) {
  const cs = criteria();
  const pair = cs.flatMap((x, i) => cs.slice(i + 1).filter((y) => y.weight === x.weight && y.min === x.min && y.max === x.max).map((y) => [x, y] as const))[0];
  if (!pair) throw new Error("the fixture's rubric has no two criteria of equal weight and scale");
  const [hi, lo] = pair;
  const [p, q, rest] = round.finalists;
  const base = Object.fromEntries(cs.map((x) => [x.key, x.min]));
  for (const j of panel) {
    saveFinalsScore(j, "evt_01", { finals: round.id, project: p!, values: { ...base, [hi.key]: hi.min, [lo.key]: lo.max } });
    saveFinalsScore(j, "evt_01", { finals: round.id, project: q!, values: { ...base, [hi.key]: hi.max, [lo.key]: lo.min } });
    saveFinalsScore(j, "evt_01", { finals: round.id, project: rest!, values: base });
  }
  return { p: p!, q: q!, criterion: hi };
}

describe("the tie-break through withFinals in getPublishedResults", () => {
  it("an exact finals tie is split by the criterion on the panel's own figures, said as a tie in the finals", () => {
    settleDecisions();
    const { round, a, b, c } = openPanel();
    const { p, q, criterion } = plantFinalsTie(round, [a, b, c]);
    setTieBreak(organizer(), "evt_01", { criterionId: criterion.id, reason: "Decided before judging" });
    closeFinals(organizer(), "evt_01", round.id, {});
    publishResults(organizer(), "evt_01");
    const r = published();
    const rows = r.tracks.find((t) => t.id === "trk_01")!.rows;
    const rp = rows.find((x) => x.projectId === p)!;
    const rq = rows.find((x) => x.projectId === q)!;
    expect(Math.abs(rp.finals!.score! - rq.finals!.score!)).toBeLessThanOrEqual(1e-9);
    // q is higher on the criterion in the finals, so q places first whatever the first round said
    expect(rows.indexOf(rq)).toBeLessThan(rows.indexOf(rp));
    expect([rq.place, rp.place]).toEqual([1, 2]);
    expect(rq.tieBroken && rp.tieBroken).toBe(true);
    expect(tieBrokenByOf(rq, r.tieBreak, { place: 1, joint: false })).toMatchObject({ inFinals: true, figure: criterion.max });
    const csv = exportFile(organizer(), "evt_01", "finals.csv").body.trim().split(/\r?\n/).map((l) => l.split(","));
    const head = csv[0]!;
    const placeOf = (id: string) => csv.find((l) => l[head.indexOf("project_id")] === id && l[head.indexOf("score_id")] === "")![head.indexOf("finals_place")];
    expect([placeOf(q), placeOf(p)]).toEqual(["1", "2"]);
  });

  it("a first-round tie below the finalists is said as a tie on score (the control)", () => {
    expect(tieBrokenByOf({ tieBroken: true, tie: 3, finals: null }, { criterion: "Impact" }, { place: 4, joint: false })).toEqual({ criterion: "Impact", figure: 3, inFinals: false });
    expect(tieBrokenByOf({ tieBroken: true, tie: 3, finals: { score: null } }, { criterion: "Impact" }, { place: 3, joint: false })).toMatchObject({ inFinals: false });
    expect(tieBrokenByOf({ tieBroken: false, tie: 3 }, { criterion: "Impact" }, { place: 4, joint: false })).toBeNull();
  });
});

describe("finalsTrackIds: the tracks a finals round decides", () => {
  it("none without finals; the round's track, open or closed; every finalist's track for a round over every track", () => {
    expect(finalsTrackIds(handle().db, "evt_01")).toEqual(new Set());
    openPanel("trk_01");
    expect(finalsTrackIds(handle().db, "evt_01")).toEqual(new Set(["trk_01"]));
  });

  it("a round over every track names the tracks of its finalists", () => {
    const { round } = openPanel(null);
    const tracks = new Set(sqlAll<{ t: string }>(`SELECT DISTINCT track_id AS t FROM projects WHERE id IN (${round.finalists.map(() => "?").join(",")})`, ...round.finalists).map((r) => r.t));
    expect(tracks.size).toBeGreaterThan(1);
    expect(finalsTrackIds(handle().db, "evt_01")).toEqual(tracks);
  });
});
