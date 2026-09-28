import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { CORRECTED_FROM, getPublishedResults, publishResults, type PublishedResults } from "@/server/dal/results";
import { getPairwiseState, pickPairwise, pullShare, setJudgingMode, PAIRWISE_METHOD } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";
import { RankingEvidence } from "@/components/results/ranking-evidence";

// The public results page's "How this ranking was reached" block: shown only once results are
// published, built only from the published run, and never naming a judge or carrying a judge's id.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

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

function checker(label: "organizer" | "judge_a") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
}

/** The fixture's three open decisions, settled, so the event can publish. */
function settle() {
  const org = checker("organizer");
  mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  return org;
}

const render = (results: PublishedResults) => renderToStaticMarkup(createElement(RankingEvidence, { results }));

/** Every judge of the event, by id and by name. */
function judgesOfEvent(): { id: string; name: string }[] {
  return h.sqlite
    .prepare("SELECT DISTINCT u.id, u.name FROM assignments a JOIN users u ON u.id = a.judge_user_id WHERE a.event_id = 'evt_01'")
    .all() as { id: string; name: string }[];
}

/** The judge ids and names found in a text: the detector the identity test relies on. */
function judgeLeaks(text: string, judges: { id: string; name: string }[]): string[] {
  return judges.flatMap((j) => [j.id, j.name].filter((s) => s && text.includes(s)));
}

const runParams = (runId: string) => (h.sqlite.prepare("SELECT params FROM normalization_runs WHERE id = ?").get(runId) as { params: string }).params;

describe("How this ranking was reached (public results page)", () => {
  it("renders nothing until the results are published, and then the block", () => {
    const before = getPublishedResults("evt_01");
    expect(before).toEqual({ published: false });
    expect(render(before)).toBe("");
    settle();
    publishResults(checker("organizer"), "evt_01");
    const html = render(getPublishedResults("evt_01"));
    expect(html).toContain("How this ranking was reached");
    expect(html).toContain("Signal check");
    expect(html).toContain("JUDGING.md");
  });

  it("its numbers are the stored run's, in totals: judges counted and corrected, the largest correction, the signal check, the audit entry", () => {
    settle();
    const { runId } = publishResults(checker("organizer"), "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    const e = results.evidence;
    if (e.kind !== "scores") throw new Error("expected a scores run");
    const params = JSON.parse(runParams(runId)) as {
      k: number;
      judges: { leniency: number }[];
      excluded: string[];
      signal: { share: number; trials: number };
      yardstick: { largestLeniency: number };
    };
    const sizes = params.judges.map((j) => Math.abs(j.leniency));
    expect(e.k).toBe(params.k);
    expect(e.judges).toMatchObject({ counted: params.judges.length, corrected: sizes.filter((x) => x >= CORRECTED_FROM).length });
    expect(e.judges!.largest).toBeCloseTo(params.yardstick.largestLeniency, 12);
    expect(e.excluded).toBe(1);
    expect(e.signal).toEqual({ share: params.signal.share, trials: params.signal.trials });
    expect(e.placed).toBe(40);
    // the fixture's scores do not separate the projects (JUDGING.md): the block says so, not the opposite
    expect(params.signal.share).toBeGreaterThan(0.05);
    const html = render(results);
    expect(html).toContain("do not separate the projects better than chance");
    expect(html).not.toContain("separate the projects better than chance: the scores");
    expect(html).toContain(`entry #${results.anchor!.entry}`);
    expect(html).toContain(results.anchor!.hash.slice(0, 16));
    expect(html).toContain(`largest correction was ${e.judges!.largest.toFixed(2)}`);
  });

  it("names no judge and carries no judge id, in the page block or in the API's evidence", () => {
    settle();
    const { runId } = publishResults(checker("organizer"), "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    const judges = judgesOfEvent();
    expect(judges.length).toBeGreaterThan(20);
    // Known-bad control: the stored run itself holds judge ids, and a block that printed a judge's name would be caught.
    expect(judgeLeaks(runParams(runId), judges).length).toBeGreaterThan(0);
    expect(judgeLeaks(render(results) + judges[0]!.name, judges)).toEqual([judges[0]!.name]);
    // the block and the evidence object: nothing
    expect(judgeLeaks(render(results), judges)).toEqual([]);
    expect(judgeLeaks(JSON.stringify(results.evidence), judges)).toEqual([]);
    // and no per-judge list: every field is a number, or a small object of numbers
    const flat = JSON.stringify(results.evidence);
    expect(flat).not.toMatch(/\[/);
  });

  it("a pairwise run says its answers and pulls, and has no signal line it did not measure", () => {
    const org = checker("organizer");
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judge = checker("judge_a");
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, newId: t.current!.newId, outcome: "left" });
    settle();
    publishResults(org, "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    expect(results.method).toBe(PAIRWISE_METHOD);
    const e = results.evidence;
    if (e.kind !== "pairwise") throw new Error("expected a pairwise run");
    expect(e.answers).toBe(1);
    expect(e.fromScores).toBeGreaterThan(0);
    // one answer cannot measure either pull
    expect(pullShare({ est: 0, se: 10 })?.measured).toBe(false);
    expect(e.left).toBeNull();
    const html = render(results);
    expect(html).toContain("1 answer from");
    expect(html).toContain("too few answers to measure");
    expect(html).not.toContain("Signal check");
    expect(judgeLeaks(html, judgesOfEvent())).toEqual([]);
  });
});
