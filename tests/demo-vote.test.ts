import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_VOTE_DAYS, demoVoteCode, ensureDemoOrganizer, seedDemoVote } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { auditLog, events } from "@/server/db/schema";
import { enterVoting } from "@/server/dal/voting";
import { sha256 } from "@/server/util";

// Demo mode gives the sample event a community vote a visitor can try (a judge's-eye
// review found the T3 vote could not be tried from the seeded tour).

let h: Handle;
const NOW = new Date().toISOString();
const client = { ip: "198.51.100.20", agent: "test" };
const event = () => h.db.select().from(events).where(eq(events.id, "evt_01")).get()!;
const opened = () => h.db.select().from(auditLog).where(eq(auditLog.action, "voting.demo_opened")).all().length;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256: digest } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256: digest, now: NOW });
  ensureDemoOrganizer(h.db, "evt_01", NOW);
  setHandleForTests(h);
});

afterEach(() => {
  setHandleForTests(null);
  h.sqlite.close();
});

describe("the demo community vote", () => {
  it("opens once for 30 days to accounts and one open link, and the printed link lets a visitor in", () => {
    const first = seedDemoVote(h.db, "evt_01", NOW);
    expect(first.opened).toBe(true);
    const e = event();
    expect(Date.parse(e.votingCloseAt!) - Date.parse(e.votingOpenAt!)).toBe(DEMO_VOTE_DAYS * 86_400_000);
    expect(e.settings.voting).toEqual({ modes: ["account", "link"], votesPerVoter: 3, linkHash: sha256(demoVoteCode()), countLink: false });
    expect(opened()).toBe(1);
    expect(enterVoting(first.code, client).eventId).toBe("evt_01");

    // A second start changes nothing and still reports the link.
    const again = seedDemoVote(h.db, "evt_01", NOW);
    expect(again).toMatchObject({ opened: false, code: first.code });
    expect(event().settings.voting).toEqual(e.settings.voting);
    expect(opened()).toBe(1);
  });

  it("does not open once results are published: a vote then would run with the ranking in view", () => {
    h.db.update(events).set({ resultsPublishedAt: NOW }).where(eq(events.id, "evt_01")).run();
    expect(seedDemoVote(h.db, "evt_01", NOW)).toMatchObject({ opened: false, code: "" });
    expect(event().votingOpenAt).toBeNull();
    expect(opened()).toBe(0);
  });

  it("never replaces an organizer's own vote settings, and then prints no link", () => {
    const mine = { modes: ["listed" as const], votesPerVoter: 5, linkHash: null };
    h.db.update(events)
      .set({ votingOpenAt: "2026-10-01T00:00:00.000Z", votingCloseAt: "2026-10-02T00:00:00.000Z", settings: { ...event().settings, voting: mine } })
      .where(eq(events.id, "evt_01"))
      .run();
    expect(seedDemoVote(h.db, "evt_01", NOW)).toMatchObject({ opened: false, code: "" });
    expect(event().settings.voting).toEqual(mine);
    expect(event().votingOpenAt).toBe("2026-10-01T00:00:00.000Z");
    expect(opened()).toBe(0);
  });
});
