import path from "node:path";
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The request's session cookie, as the page reads it: null for a visitor.
const session: { token: string | null } = { token: null };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && session.token ? { value: session.token } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import OverallResultsPage from "@/app/events/[event]/results/overall/page";
import ResultsPage from "@/app/events/[event]/results/page";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { acceptUnderReviewed, eventDecisions, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { runAssignment } from "@/server/dal/assignments";
import { moveProjectTrack } from "@/server/dal/corrections";
import { requireEvent } from "@/server/dal/events";
import { saveRubric } from "@/server/dal/organize";
import { renameTeam } from "@/server/dal/teams";
import { setTieBreak } from "@/server/dal/tiebreak";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { getPairwiseState, pickPairwise, setJudgingMode } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";
import { overallOrder } from "@/lib/overall";

// The public overall order (/events/[event]/results/overall): every ranked project in one list by the
// published run's rankOverall, each beside its place in its track as the per-track page shows it; hidden
// exactly when the per-track results are; in pairwise mode it says why no overall order applies.

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
let tokens: Record<string, string>;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

beforeEach(() => {
  process.env.SEED_CHECKER_SESSIONS = "true";
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  tokens = Object.fromEntries(seeded.identities.map((i) => [i.label, i.token]));
  session.token = null;
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
  process.env.SEED_CHECKER_SESSIONS = saved.flag;
  session.token = null;
});

const actor = (label: string) => actorForToken(h.db, tokens[label]!)!;

/** The fixture's three open decisions, settled, then the results published. */
function publish() {
  const org = actor("organizer");
  mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  publishResults(org, "evt_01");
}

const params = { params: Promise.resolve({ event: "evt_01" }) };
/** A page rendered to the end, its async parts (the shell's) awaited, as the server sends it. */
async function render(el: ReactNode): Promise<string> {
  const { prelude } = await prerender(el);
  return new Response(prelude).text();
}
const overallHtml = async () => render(await OverallResultsPage(params as never));
const perTrackHtml = async () => render(await ResultsPage(params as never));

/** Each list item's project id and screen-reader place text, in the order the list shows them. */
function overallRows(html: string): { id: string; place: string }[] {
  return [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].flatMap((m) => {
    const id = m[1]!.match(/\/projects\/(prj_\w+)"/)?.[1];
    const place = m[1]!.match(/<span class="sr-only">([^<]*)<\/span>/)?.[1];
    return id && place ? [{ id, place }] : [];
  });
}

/** Each placed row of the per-track page: its project and the place its screen-reader text states. */
function perTrackPlaces(html: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of html.matchAll(/\/projects\/(prj_\w+)"[^>]*>[^<]*<\/a><span[^>]*>[^<]*<span class="sr-only"> · (\d+)(?:st|nd|rd|th) in /g)) out.set(m[1]!, Number(m[2]));
  return out;
}

describe("the public overall order", () => {
  it("is hidden before publishing, for a visitor and for a participant, and shows every ranked project after", async () => {
    const titles = (h.sqlite.prepare("SELECT title FROM projects WHERE event_id = 'evt_01'").all() as { title: string }[]).map((r) => r.title);
    for (const who of [null, "participant"]) {
      session.token = who ? tokens[who]! : null;
      const html = await overallHtml();
      expect(html).toContain("Not yet published");
      expect(overallRows(html)).toEqual([]);
      expect(html).not.toMatch(/± \d/);
      for (const t of titles) expect(html).not.toContain(`>${t}<`);
    }
    // positive control: the same reads show the list once the results are out
    publish();
    for (const who of [null, "participant"]) {
      session.token = who ? tokens[who]! : null;
      const html = await overallHtml();
      expect(html).not.toContain("Not yet published");
      expect(overallRows(html).length).toBeGreaterThan(10);
      expect(html).toContain("Places and prizes are decided within each track.");
    }
  });

  it("an unknown event is a 404, as on the per-track page", async () => {
    await expect(OverallResultsPage({ params: Promise.resolve({ event: "no-such-event" }) } as never)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("lists every ranked project in rankOverall's order, positions counted from it", async () => {
    publish();
    const results = getPublishedResults("evt_01");
    if (!results.published) throw new Error("not published");
    const ranked = results.tracks.flatMap((t) => t.rows).filter((r) => r.rankOverall !== null);
    // the known order, straight from the stored run; ties keep the per-track read's order
    const expected = [...ranked].sort((a, b) => a.rankOverall! - b.rankOverall!).map((r) => r.projectId);
    const shown = overallRows(await overallHtml()).map((r) => r.id);
    expect(shown).toEqual(expected);
    // the order across tracks is not just the track lists one after another (else this test proves nothing)
    expect(shown).not.toEqual(ranked.map((r) => r.projectId));
    const entries = overallOrder(results.tracks);
    for (const e of entries) {
      const ahead = ranked.filter((r) => r.rankOverall! < e.row.rankOverall! - 1e-9).length;
      expect(e.position).toBe(ahead + 1);
    }
    expect(entries[0]!.position).toBe(1);
  });

  it("gives each project the same track place as the per-track page", async () => {
    publish();
    const perTrack = perTrackPlaces(await perTrackHtml());
    const rows = overallRows(await overallHtml());
    expect(perTrack.size).toBe(rows.length);
    for (const r of rows) {
      const place = Number(r.place.match(/^(\d+)/)![1]);
      expect(place, r.id).toBe(perTrack.get(r.id));
    }
  });

  it("ties share a position, marked joint", () => {
    const row = (projectId: string, score: number, rankOverall: number) => ({ projectId, score, rankOverall });
    const entries = overallOrder([
      { id: "a", name: "A", rows: [row("p1", 4, 1.5), row("p2", 3, 3)] },
      { id: "b", name: "B", rows: [row("p3", 4, 1.5), row("p4", 2, 4)] },
    ]);
    expect(entries.map((e) => [e.row.projectId, e.position, e.joint, e.trackPlace.place])).toEqual([
      ["p1", 1, true, 1],
      ["p3", 1, true, 1],
      ["p2", 3, false, 2],
      ["p4", 4, false, 2],
    ]);
  });

  it("leaves out a project with no place in its track, and counts the rest's positions without it", () => {
    const entries = overallOrder([
      { id: "a", name: "A", rows: [{ projectId: "p1", score: 4, rankOverall: 1 }, { projectId: "p2", score: null, rankOverall: null }] },
      { id: "b", name: "B", rows: [{ projectId: "p3", score: 3, rankOverall: 2 }] },
    ]);
    expect(entries.map((e) => [e.row.projectId, e.position])).toEqual([
      ["p1", 1],
      ["p3", 2],
    ]);
  });

  it("links from the per-track page and back", async () => {
    publish();
    const perTrack = await perTrackHtml();
    expect(perTrack.match(/href="\/events\/[^"]+\/results\/overall"/g)).toHaveLength(1);
    expect(perTrack).toContain("Every project in one order, across tracks");
    const overall = await overallHtml();
    expect(overall).toMatch(/href="\/events\/[^"]+\/results"[^>]*>Places per track</);
  });

  it("in pairwise mode says why no overall order applies, and the per-track page does not link to it", async () => {
    const org = actor("organizer");
    setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judge = actor("judge_a");
    const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
    pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, newId: t.current!.newId, outcome: "left" });
    publish();
    const html = await overallHtml();
    expect(html).toContain("No overall order for this event");
    expect(html).toContain("A win % compares only within its own track");
    expect(overallRows(html)).toEqual([]);
    expect(await perTrackHtml()).not.toContain("/results/overall");
  });

  describe("what the organizers changed after the fact, disclosed as on the per-track page", () => {
    const WEIGHT_REASON = "The first criterion was meant to count double";
    const MOVE_REASON = "The team entered the wrong track";
    const TEAM_REASON = "The team asked by mail; a typo";

    /** Every open decision settled, whatever the changes opened, then the results published. */
    function settleAndPublish() {
      const org = actor("organizer");
      for (const d of eventDecisions(h.db, requireEvent(h.db, "evt_01"))) {
        if (d.resolved) continue;
        if (d.kind === "flat_judge" || d.kind === "coin_flip_judge") setJudgeOverride(org, "evt_01", { judgeUserId: d.judgeId, mode: "exclude", reason: "Checked, left out" });
        else if (d.kind === "duplicate") mergeDuplicate(org, "evt_01", { keepId: d.copies[0]!.id, duplicateId: d.copies[1]!.id });
        else if (d.kind === "under_reviewed") acceptUnderReviewed(org, "evt_01", { projectId: d.projectId, reason: "Publish with what it has" });
      }
      publishResults(org, "evt_01");
    }

    /** The list item of one project, as the page sends it. */
    const itemOf = (html: string, projectId: string) =>
      [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) => m[1]!).find((li) => li.includes(`/projects/${projectId}"`));

    it("the rubric weights changed after scoring, a project moved and a team changed: each shows on the overall page, as on the per-track page", async () => {
      const org = actor("organizer");
      // a weight changed once judges had scored, with the reason
      const criteria = (
        h.sqlite.prepare("SELECT id, label, prompt, weight FROM rubric_criteria WHERE event_id = 'evt_01' ORDER BY position").all() as {
          id: string;
          label: string;
          prompt: string;
          weight: number;
        }[]
      ).map((c, i) => ({ ...c, weight: i === 0 ? 2 : c.weight }));
      expect(saveRubric(org, "evt_01", { criteria, reason: WEIGHT_REASON }).reweighted).toBe(true);
      // a reviewed project moved to another track after judges were assigned
      runAssignment(org, "evt_01", { mode: "topup", seed: 42 });
      const moved = h.sqlite
        .prepare(
          `SELECT p.id, p.track_id AS track FROM projects p
            WHERE p.event_id = 'evt_01' AND p.status = 'submitted' AND p.duplicate_of IS NULL
              AND EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = p.id AND a.status = 'done')
            ORDER BY p.id LIMIT 1`,
        )
        .get() as { id: string; track: string };
      const to = h.sqlite.prepare("SELECT id, name FROM tracks WHERE event_id = 'evt_01' AND id <> ? ORDER BY position LIMIT 1").get(moved.track) as {
        id: string;
        name: string;
      };
      moveProjectTrack(org, "evt_01", moved.id, { trackId: to.id, reason: MOVE_REASON });
      // another project's team renamed by the organizers after the close
      const renamed = moved.id === "prj_02" ? "prj_03" : "prj_02";
      const team = (h.sqlite.prepare("SELECT team_id AS t FROM projects WHERE id = ?").get(renamed) as { t: string }).t;
      renameTeam(org, team, { name: "Glass Signal Crew", reason: TEAM_REASON });
      settleAndPublish();

      const results = getPublishedResults("evt_01");
      if (!results.published) throw new Error("not published");
      const ranked = new Set(results.tracks.flatMap((t) => t.rows).filter((r) => r.rankOverall !== null).map((r) => r.projectId));
      expect(ranked.has(moved.id) && ranked.has(renamed), "both changed projects are in the overall list").toBe(true);

      for (const [page, html] of [["overall", await overallHtml()], ["per-track", await perTrackHtml()]] as const) {
        // the weights, with the reason
        expect(html, page).toContain("The organizers changed the rubric’s weights after judging began.");
        expect(html, page).toContain(WEIGHT_REASON);
        // the move: one project counted in the notice, the mark on its own row with the reason
        expect(html, page).toMatch(/The organizers moved (<!-- -->)?1 project(<!-- -->)? to another track after judges were assigned\./);
        const movedItem = itemOf(html, moved.id);
        expect(movedItem, page).toContain(`to ${to.name} on`);
        expect(movedItem, page).toContain(MOVE_REASON);
        expect(movedItem, page).not.toContain("Team changed by the organizers");
        // the team change, on its own row only
        expect(itemOf(html, renamed), page).toContain("Team changed by the organizers after submissions closed");
        expect(html.match(/Team changed by the organizers after submissions closed/g), page).toHaveLength(1);
      }
    });

    it("a place the tie-break decided: each overall row says so exactly as its per-track row does, with the same track place", async () => {
      const org = actor("organizer");
      const crit = (key: string) => (h.sqlite.prepare("SELECT id FROM rubric_criteria WHERE event_id = 'evt_01' AND key = ?").get(key) as { id: string }).id;
      // plant an exact tie between prj_05 and prj_21 (tests/tiebreak.test.ts's plant): prj_21's reviews take prj_05's
      // values with functionality and innovation swapped, equal weights, so the totals tie and functionality splits them
      h.sqlite.prepare("UPDATE rubric_criteria SET weight = 1 WHERE event_id = 'evt_01'").run();
      const [f, q, i] = [crit("functionality"), crit("quality"), crit("innovation")];
      const items = (project: string) =>
        h.sqlite
          .prepare(
            "SELECT a.judge_user_id AS judge, s.id AS scoreId, si.criterion_id AS criterionId, si.value AS value FROM assignments a JOIN scores s ON s.assignment_id = a.id JOIN score_items si ON si.score_id = s.id WHERE a.project_id = ?",
          )
          .all(project) as { judge: string; scoreId: string; criterionId: string; value: number }[];
      const from = items("prj_05");
      const swap = new Map([
        [f, i],
        [i, f],
        [q, q],
      ]);
      for (const t of items("prj_21")) {
        const src = from.find((x) => x.judge === t.judge && x.criterionId === swap.get(t.criterionId))!;
        h.sqlite.prepare("UPDATE score_items SET value = ? WHERE score_id = ? AND criterion_id = ?").run(src.value, t.scoreId, t.criterionId);
      }
      setTieBreak(org, "evt_01", { criterionId: f, reason: "Working software decides an exact tie" });
      settleAndPublish();

      const results = getPublishedResults("evt_01");
      if (!results.published || !results.tieBreak) throw new Error("expected a published tie-break");
      const broken = results.tracks.flatMap((t) => t.rows).filter((r) => r.tieBroken).map((r) => r.projectId).sort();
      expect(broken).toEqual(expect.arrayContaining(["prj_05", "prj_21"]));

      const overall = await overallHtml();
      const perTrack = await perTrackHtml();
      const note = (html: string, id: string) => itemOf(html, id)?.match(/Tied on score; tie broken by (<!-- -->)?[^<]*(<!-- -->)?(<span class="tnum">, [0-9.]+<\/span>)?/)?.[0] ?? null;
      for (const id of broken) {
        expect(note(overall, id)?.replaceAll("<!-- -->", ""), id).toContain(`tie broken by ${results.tieBreak.criterion}`);
        expect(note(overall, id), id).toBe(note(perTrack, id));
      }
      // only the decided rows carry it, on both pages (the per-track page also names it once under a track winner, in its figure of first places)
      expect(overallRows(overall).map((r) => r.id).filter((id) => note(overall, id) !== null).sort()).toEqual(broken);
      expect(overall.match(/Tied on score; tie broken by/g)).toHaveLength(broken.length);
      expect([...perTrackPlaces(perTrack).keys()].filter((id) => note(perTrack, id) !== null).sort()).toEqual(broken);
      // the change of rule, with its reason, on both pages
      for (const html of [overall, perTrack]) expect(html).toContain("Working software decides an exact tie");
      // and the track places still agree, the tie-break's order included
      const places = perTrackPlaces(perTrack);
      for (const r of overallRows(overall)) expect(Number(r.place.match(/^(\d+)/)![1]), r.id).toBe(places.get(r.id));
      expect(places.get("prj_05")).not.toBe(places.get("prj_21"));
    });

    it("control: with no change after the fact, the overall page shows none of these", async () => {
      publish();
      const html = await overallHtml();
      expect(overallRows(html).length).toBeGreaterThan(10);
      expect(html).not.toContain("weights after judging began");
      expect(html).not.toContain("to another track after judges were assigned");
      expect(html).not.toContain("Team changed by the organizers");
    });
  });
});
