import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { getPairwiseRanking, getPairwiseState, pickPairwise, setJudgingMode } from "@/server/dal/pairwise";
import { candidatesOf, pairwiseCandidates } from "@/server/dal/prize-candidates";
import { competitionPlaces } from "@/lib/places";
import { actorForToken } from "@/server/session";

// The Prizes step places each project as publishing will (JUDGING.md "Prizes"). In pairwise mode a project no judge
// compared publishes with no score, so it is "not placed"; the step must say the same and place every compared
// project exactly where the published results will.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function checker(label: "organizer" | "judge_a") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
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

describe("the pairwise Prizes step places as publishing does", () => {
  it("a project no judge compared is not placed, and every other place equals the published one", () => {
    const org = checker("organizer");
    // prj_19's one judge recused: no judge compared it, so it publishes as "not placed"
    h.sqlite.prepare("UPDATE assignments SET status = 'recused' WHERE project_id = 'prj_19'").run();
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judge = checker("judge_a");
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, outcome: "left" });
    mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "only one judge compared it" });
    setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "flat scores" });

    const ranking = getPairwiseRanking(org, "evt_01");
    const uncompared = ranking.tracks.flatMap((x) => x.rows).filter((r) => r.comparisons === 0);
    // the case under test exists: at least one project no judge compared, accepted as under-reviewed to publish
    expect(uncompared.length).toBeGreaterThan(0);
    const step = pairwiseCandidates(ranking);
    // known-bad: placing by the raw win percentage (the old rule) gives other places than the step now shows
    const old = candidatesOf(ranking.tracks.map((x) => ({ trackName: x.name, rows: x.rows.map((r) => ({ projectId: r.projectId, title: r.title, teamName: r.teamName, score: r.winPct })) })));
    const placeMap = (list: { projectId: string; place: number | null }[]) => Object.fromEntries(list.map((c) => [c.projectId, c.place]));
    expect(placeMap(old)).not.toEqual(placeMap(step));

    publishResults(org, "evt_01", { reason: "one comparison is what we have" });
    const pub = getPublishedResults("evt_01");
    if (!pub.published) throw new Error("expected published results");
    const published: Record<string, number | null> = {};
    for (const track of pub.tracks) {
      const places = competitionPlaces(track.rows);
      track.rows.forEach((r, i) => (published[r.projectId] = places[i]!.place));
    }
    for (const u of uncompared) expect(placeMap(step)[u.projectId] ?? null).toBeNull();
    expect(placeMap(step)).toEqual(Object.fromEntries(step.map((c) => [c.projectId, published[c.projectId] ?? null])));
  });
});
