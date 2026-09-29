import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import { organizer, sqlGet, withFixtureEvent } from "./support/fixture-harness";

// The pages a visitor reads once the results are out: the public results list each prize with its winners and each
// winner's place in its track as the published results give it (a prize is the organizers' choice; the place is the
// engine's), and a winner's own project page says "Winner, <prize>". Rendered as Next renders them, anonymously.

let cookie: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "session" && cookie ? { value: cookie } : undefined), set: vi.fn(), delete: vi.fn() }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  usePathname: () => "/events/sample-hack-2026/results",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh() {} }),
}));

const h = withFixtureEvent();
const { createLoginSession } = await import("@/server/session");
const { savePrizes } = await import("@/server/dal/organize");
const { awardPrize } = await import("@/server/dal/prize-awards");
const { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } = await import("@/server/dal/decisions");
const { getNormalization, publishResults } = await import("@/server/dal/results");
const { scoreCandidates } = await import("@/app/organize/[event]/results/prize-candidates");
const ResultsPage = (await import("@/app/events/[event]/results/page")).default;
const ProjectPage = (await import("@/app/events/[event]/projects/[project]/page")).default;
const SettingsPage = (await import("@/app/organize/[event]/settings/page")).default;

const html = async (page: unknown) => {
  const { prelude } = await prerender(page as never);
  return await new Response(prelude).text();
};
const results = async () => html(await ResultsPage({ params: Promise.resolve({ event: "sample-hack-2026" }) } as never));
const project = async (id: string) => html(await ProjectPage({ params: Promise.resolve({ event: "sample-hack-2026", project: id }) } as never));

/** Settles the fixture's decisions and gives "Best in show" to a project placed 4th in its track; publishing is left to the test. */
function awardToAFourth() {
  savePrizes(organizer(), "evt_01", [{ name: "Best in show", description: "The judges' favourite" }]);
  setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
  mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
  const live = getNormalization(organizer(), "evt_01");
  const fourth = scoreCandidates(live.normalization, live.tieBreak).find((c) => c.place === 4 && !c.joint)!;
  const prize = sqlGet<{ id: string }>("SELECT id FROM prizes WHERE event_id = 'evt_01'")!.id;
  awardPrize(organizer(), "evt_01", prize, { projectIds: [fourth.projectId], note: "Bold idea" });
  return fourth;
}

describe("the published prize on the public pages", () => {
  it("the results page lists the prize, its winner with the winner's place, and the caption; the winner's page says Winner", async () => {
    const fourth = awardToAFourth();
    publishResults(organizer(), "evt_01");
    const page = await results();
    const at = page.indexOf('id="prizes-title"');
    expect(at).toBeGreaterThan(0);
    const block = page.slice(at, page.indexOf("</section>", at)).replaceAll("<!-- -->", "");
    expect(block).toContain("Best in show");
    expect(block).toContain(fourth.title.replace(/&/g, "&amp;"));
    expect(block).toContain(`${fourth.teamName} · ${fourth.trackName} · 4th`.replace(/&/g, "&amp;"));
    expect(block).toContain("Chosen by the organizers; each winner");
    expect(block).toContain("place is the engine");
    expect(block).toContain("Bold idea");

    const own = await project(fourth.projectId);
    expect(own).toMatch(/aria-label="Prizes won"[^>]*>[\s\S]*Winner(<!-- -->)?, (<!-- -->)?Best in show/);
  });

  it("positive control: before publishing neither page shows the prize", async () => {
    const fourth = awardToAFourth();
    expect(await results()).not.toContain('id="prizes-title"');
    expect(await project(fourth.projectId)).not.toContain("Prizes won");
  });
});

describe("the Settings page's Prizes editor", () => {
  /** the Prizes section of the Settings page as the organizer sees it */
  const prizesSection = async () => {
    cookie = createLoginSession(h().db, "usr_organizer").token;
    try {
      const page = await html(await SettingsPage({ params: Promise.resolve({ event: "sample-hack-2026" }) } as never));
      const at = page.indexOf(`id="prizes-title"`);
      expect(at).toBeGreaterThan(0);
      return page.slice(at, page.indexOf("</form>", at)).replaceAll("<!-- -->", "");
    } finally {
      cookie = undefined;
    }
  };
  const inputs = (section: string) => [...section.matchAll(/<input[^>]*id="prizes-[0-9]+-[^"]*"[^>]*>/g)].map((m) => m[0]);

  it("before publishing, says which prize is awarded to whom and that removing it takes the award back; the rows stay editable", async () => {
    const fourth = awardToAFourth();
    const section = await prizesSection();
    expect(section).toContain(`Best in show is awarded to ${fourth.title.replace(/&/g, "&amp;")}; removing the prize takes the award back`);
    expect(inputs(section).length).toBeGreaterThan(0);
    expect(inputs(section).some((i) => / disabled=""/.test(i))).toBe(false);
  });

  it("after publishing with a prize awarded, the prize rows are disabled and the section says why", async () => {
    awardToAFourth();
    publishResults(organizer(), "evt_01");
    const section = await prizesSection();
    expect(section).toContain("Results are published with prizes awarded, so the prizes are final");
    expect(section).not.toContain("removing the prize takes the award back");
    expect(inputs(section).length).toBeGreaterThan(0);
    expect(inputs(section).every((i) => / disabled=""/.test(i))).toBe(true);
  });

  it("positive control: published with no prize awarded, the prizes stay editable", async () => {
    savePrizes(organizer(), "evt_01", [{ name: "Best in show", description: "" }]);
    setJudgeOverride(organizer(), "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "Flat vector, confirmed by hand" });
    mergeDuplicate(organizer(), "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
    acceptUnderReviewed(organizer(), "evt_01", { projectId: "prj_19", reason: "One review is all it can get" });
    publishResults(organizer(), "evt_01");
    const section = await prizesSection();
    expect(section).not.toContain("so the prizes are final");
    expect(inputs(section).some((i) => / disabled=""/.test(i))).toBe(false);
  });
});
