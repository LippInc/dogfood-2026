import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { getNormalization, METHOD_LABEL } from "@/server/dal";
import { getPairwiseRanking, setJudgingMode } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";
import { plainSummary } from "@/app/organize/[event]/results/plain-summary";
import { ScoreOpening } from "@/app/organize/[event]/results/score-opening";
import { PairwiseResults } from "@/app/organize/[event]/results/pairwise-results";

// The organizer's Results tab opened with a bold formula paragraph (METHOD_LABEL, k, β̂², σ̂²) right under
// its heading: a stranger met the statistics before knowing what the page tells them (judge's-eye reading 8,
// big-picture check of Organizer operations, 2026-09-29). Now a plain sentence comes first, the numbered lines
// follow, the formula sits in a closed fold, and the rules the organizer acts on (flat judges, coin flips, who
// is left out) stay outside it.

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

function organizer() {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === "organizer")!.token)!;
}

/** A text as React escapes it in markup (an apostrophe becomes &#x27;). */
const esc = (text: string) => renderToStaticMarkup(createElement("span", null, text)).slice("<span>".length, -"</span>".length);

/** The markup split at the method fold: what is inside the <details>, and where it starts and ends. */
function fold(html: string) {
  const start = html.lastIndexOf("<details", html.indexOf("data-method-fold"));
  const end = html.indexOf("</details>", start);
  expect(start, "the method sits in a <details> fold").toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const tag = html.slice(start, html.indexOf(">", start) + 1);
  return { start, end, tag, inside: html.slice(start, end) };
}

describe("The Results tab opens in plain words, the formula one click away", () => {
  it("scoring mode: plain sentence, then the numbered lines, then the formula in a closed fold, then the flat-judge rule", () => {
    const actor = organizer();
    const { event, normalization: n, decisions, published } = getNormalization(actor, "evt_01");
    const open = decisions.filter((d) => !d.resolved).length;
    const summary = plainSummary(n, { open, published: Boolean(event.resultsPublishedAt), differs: published?.differs.length ?? 0 });
    const html = renderToStaticMarkup(
      createElement(ScoreOpening, { n, summary, published, resultsPublished: Boolean(event.resultsPublishedAt), eventSlug: event.slug, open }),
    );

    const lead = html.indexOf("Each track&#x27;s ranking as it will be published");
    const list = html.indexOf('aria-label="What this run shows, in plain words"');
    const f = fold(html);
    expect(lead).toBeGreaterThan(html.indexOf("</h1>"));
    expect(lead).toBeLessThan(list);
    expect(list).toBeLessThan(f.start);
    // closed by default: no open attribute on the fold
    expect(f.tag).not.toMatch(/\bopen\b/);
    expect(html.slice(f.start)).toContain("How the leniency correction works");

    // the formula, all of it, only inside the fold
    expect(f.inside).toContain(esc(METHOD_LABEL));
    expect(n.variance.k).not.toBeNull(); // the fixture measures k, so the k sentence is the one shown
    expect(f.inside).toMatch(/This run: k = \d+\.\d \(β̂² = \d\.\d{3}, σ̂² = \d\.\d{3}\), so a judge needs \d+ reviews before half their tilt counts\./);
    for (const bit of [esc(METHOD_LABEL), "k = ", "β̂²", "σ̂²", "before half their tilt counts"]) {
      expect(html.indexOf(bit), bit).toBeGreaterThan(f.start);
      expect(html.lastIndexOf(bit), bit).toBeLessThan(f.end);
    }

    // the decisions the organizer acts on stay outside it, after it
    const rule = html.indexOf("Flat-judge rule:");
    expect(rule).toBeGreaterThan(f.end);
    const left = n.judges.filter((j) => j.excluded).map((j) => j.name);
    expect(left.length).toBeGreaterThan(0);
    expect(html.slice(f.end)).toContain(`Left out in this run: ${left.join(", ")}.`);

    // the six numbered sentences are the plain summary, unchanged
    for (const line of summary) expect(html).toContain(esc(line));
  });

  it("pairwise mode: the same order, the Bradley-Terry sentence folded, the coin-flip rule and who is left out outside", () => {
    const actor = organizer();
    setJudgingMode(actor, "evt_01", { mode: "pairwise", reason: "Trying the better-of-two mode" });
    const ranking = getPairwiseRanking(actor, "evt_01");
    const html = renderToStaticMarkup(createElement(PairwiseResults, { ranking, eventId: "evt_01", eventSlug: "evt_01", published: false, chosen: null }));

    const lead = html.indexOf("Each track&#x27;s ranking as it will be published, worked out from the judges&#x27; either/or answers");
    const f = fold(html);
    expect(lead).toBeGreaterThan(html.indexOf("</h1>"));
    expect(lead).toBeLessThan(f.start);
    expect(f.tag).not.toMatch(/\bopen\b/);
    expect(f.inside).toContain(esc(`Pairwise: ${ranking.method}.`));
    expect(f.inside).toContain("k − 1 answers together");
    expect(html.indexOf("Pairwise: ")).toBeGreaterThan(f.start);

    const rule = html.indexOf("Coin-flip rule:");
    expect(rule).toBeGreaterThan(f.end);
    expect(html.slice(f.end)).toMatch(ranking.leftOut.length ? /Left out of the fit: / : /Nobody is left out of the fit\./);
  });
});
