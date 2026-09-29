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
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
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
});
