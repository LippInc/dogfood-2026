import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { CORRECTED_FROM, evidenceOf, getPublishedResults, publishResults, type PublishedResults } from "@/server/dal/results";
import { getPairwiseState, pickPairwise, pullShare, setJudgingMode, PAIRWISE_METHOD } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";
import { mostlyFromScores, pairwiseSources, RankingEvidence, winPctMethod } from "@/components/results/ranking-evidence";

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
    // the threshold the count uses is the one the sentence states (0.005 counted as 'corrected by 0.01' before)
    expect(html).toContain(`corrected by at least ${CORRECTED_FROM} points`);
  });

  it("counts a project as moved when its printed place differs, ties included: joint 1st to 2nd is a move", () => {
    // raw A = B = 0.6 share 1st; by score A is 1st and B 2nd. Average ranks (1.5 to 2) called that no move.
    const tie = evidenceOf("x", {}, [
      [
        { projectId: "A", score: 0.62, raw: 0.6 },
        { projectId: "B", score: 0.58, raw: 0.6 },
        { projectId: "C", score: 0.4, raw: 0.4 },
      ],
    ]);
    expect(tie.moved).toBe(1);
    // positive control: the same order both ways, with the same tie, moves nobody
    const same = evidenceOf("x", {}, [
      [
        { projectId: "A", score: 0.6, raw: 0.6 },
        { projectId: "B", score: 0.6, raw: 0.6 },
        { projectId: "C", score: 0.4, raw: 0.4 },
      ],
    ]);
    expect(same.moved).toBe(0);
  });

  it("after the README tour, 4 projects stand at a different place than their plain average gives (prj_39 goes from joint 2nd to 3rd)", () => {
    settle();
    publishResults(checker("organizer"), "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    expect(results.evidence.moved).toBe(4);
    expect(render(results)).toContain("4 of the 40 projects stand at a different place in their track");
    // one mover reads in the singular
    expect(render({ ...results, evidence: { ...results.evidence, moved: 1 } })).toContain("1 of the 40 projects stands at a different place");
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
    // the judge count covers the answers and the score-implied pairs together (never "1 answer from 26 judges")
    expect(html).toMatch(/1 answer from judges to .* and \d+ pairs implied by scores given before the switch to this way of judging, from \d+ judges in all/);
    expect(html).not.toMatch(/1 answer from \d+ judges/);
    // each kind counted apart: the pairs implied by scores are never put under what judges answered
    expect(html).not.toMatch(/Judges answered[^.]*pairs implied/);
    expect(e.fromScores).toBeGreaterThan(e.answers);
    expect(html).toContain("More of these comparisons come from the scores than from answers.");
    // judges answer about the projects they were given, never "their own projects"
    expect(html).toContain("about projects they were given to judge");
    expect(html).not.toContain("their own projects");
    // no pull measured: the sentence must not claim the fit measured and took them out
    expect(html).not.toContain("measured and took out");
    // an unmeasured pull is still corrected for: the fit always applies its current (shrunk) estimate,
    // the 6-point gate only hides it, so the block never says the fit assumes almost none
    expect(html).toContain("neither is measured yet: the fit corrects for its current estimate of each, still mostly the prior’s");
    expect(html).not.toContain("the fit assumes almost none");
    expect(html).not.toContain("Signal check");
    expect(judgeLeaks(html, judgesOfEvent())).toEqual([]);
  });

  it("names where a pairwise ranking's comparisons came from, each kind apart, and says so only when the scores' pairs outnumber the answers", () => {
    const base = { kind: "pairwise" as const, judges: 4, left: null, fresh: null, placed: 10, moved: 0, excluded: 0 };
    expect(pairwiseSources({ ...base, answers: 12, fromScores: 0 })).toBe("12 answers from judges to “which of these two is better?” about projects they were given to judge");
    expect(pairwiseSources({ ...base, answers: 3, fromScores: 190 })).toMatch(/^3 answers from judges .* and 190 pairs implied by scores given before the switch/);
    expect(mostlyFromScores({ ...base, answers: 3, fromScores: 190 })).not.toBeNull();
    expect(mostlyFromScores({ ...base, answers: 40, fromScores: 12 })).toBeNull();
    expect(mostlyFromScores({ ...base, answers: 12, fromScores: 0 })).toBeNull();
  });

  it("says a measured pull was measured and corrected for, never that it was taken out: the fit under-reads the pulls, so part of each stays in", () => {
    const org = checker("organizer");
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    settle();
    publishResults(org, "evt_01");
    const results = getPublishedResults("evt_01");
    if (!results.published || results.evidence.kind !== "pairwise") throw new Error("expected a published pairwise run");
    // the fixture's scores alone measure no pull: plant the published evidence of an event with enough answers
    const withPulls = (left: { share: number; pm: number } | null, fresh: { share: number; pm: number } | null) =>
      render({ ...results, evidence: { ...results.evidence, kind: "pairwise", left, fresh } } as PublishedResults);
    const both = withPulls({ share: 0.57, pm: 3 }, { share: 0.54, pm: 4 });
    expect(both).toContain("The fit measured two pulls and corrected every strength for them: the side a project was shown on (57 % ± 3 between two equal projects)");
    expect(both).toContain("the project a judge had just opened (54 % ± 4 between two equal projects)");
    const one = withPulls({ share: 0.57, pm: 3 }, null);
    expect(one).toContain("The fit measured one pull and corrected for it, the side a project was shown on (57 % ± 3");
    for (const html of [both, one]) expect(html).not.toMatch(/took (them |it )?out|taken out/);
    expect(one).toContain("the other, the project a judge had just opened, is not measured yet: the fit corrects for its current estimate of it");
    expect(one).not.toContain("assumes almost none");
  });
});

describe("an unmeasured pull, on the organizer's screens", () => {
  it("says the fit corrects for its current estimate, never that it assumes almost none", () => {
    for (const file of ["src/app/organize/[event]/results/pairwise-results.tsx", "src/app/organize/[event]/page.tsx"]) {
      const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      expect(text, file).toContain("the fit corrects for its current estimate");
      expect(text, file).toContain("still mostly the prior’s");
      expect(text, file).not.toContain("assumes almost none");
    }
  });
});

describe("How these win % were made (the public results page's fold, pairwise)", () => {
  const base = { kind: "pairwise" as const, judges: 4, placed: 10, moved: 0, excluded: 0 };
  const pull = { share: 0.57, pm: 3 };

  it("says where the comparisons came from, that measured pulls were measured and corrected for, and what the ± means", () => {
    const both = winPctMethod({ ...base, answers: 12, fromScores: 190, left: pull, fresh: pull });
    expect(both).toBe(
      `Each project’s win % is its chance to beat an average project of its track, fitted from ${pairwiseSources({ ...base, answers: 12, fromScores: 190, left: pull, fresh: pull })}` +
        " (a judge’s scores in a track count as the order they imply). More of these comparisons come from the scores than from answers." +
        " The pull of the side a project was shown on and of the project a judge had just opened were measured and corrected for." +
        " The ± is one standard error: win % closer than about two of them are not told apart.",
    );
    const unmeasured = winPctMethod({ ...base, answers: 12, fromScores: 0, left: pull, fresh: null });
    expect(unmeasured).toContain("about projects they were given to judge.");
    expect(unmeasured).toContain("The fit corrects for the pull of the side a project was shown on and of the project a judge had just opened once there are answers enough to measure them");
    expect(winPctMethod(null)).toContain("fitted from judges’ answers.");
    for (const text of [both, unmeasured, winPctMethod(null)]) {
      expect(text).not.toMatch(/taken out|took (them |it )?out/);
      expect(text).not.toContain("their own projects");
    }
  });

  it("is what the page prints: the page calls it and keeps no sentence of its own about the pulls or whose projects were compared", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "src/app/events/[event]/results/page.tsx"), "utf8");
    expect(page).toContain("winPctMethod(pw)");
    const forbidden = (text: string) => [/their own projects/, /measured and taken out/, /pull of the side a project was shown on/i].filter((re) => re.test(text)).map(String);
    // known-bad control: the paragraph the page printed before this helper existed is caught on all three
    const old = "Judges answered &ldquo;which of these two is better?&rdquo; about their own projects, with the pull of the side a project was shown on and of the project a judge had just opened measured and taken out.";
    expect(forbidden(old)).toHaveLength(3);
    expect(forbidden(page)).toEqual([]);
  });
});
