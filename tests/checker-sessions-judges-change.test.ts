import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkerToken, chooseCheckerUsers, seedCheckerSessions } from "@/server/checker";
import { removeJudge } from "@/server/dal/corrections";
import { setJudgeTracks } from "@/server/dal/judges";
import { getDb } from "@/server/db/client";
import { actorForToken } from "@/server/session";
import { NOW, organizer, sqlAll, sqlGet, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// Demo mode re-derives the four checker identities on every boot. Before this, judge_a was
// "the judge with the most assignments" whether or not they were still a judge: removing the
// fixture's busiest judge (their kept reviews still count as assignments) made the next boot
// throw "no second judge shares a track with judge_a", and bootOrExit stopped the portal on
// every restart until the volume was wiped. Now only people who hold the judge role with at
// least one track are picked, and a label that cannot be filled is skipped with a warning.

withFixtureEvent();

let oldSeed: string | undefined;
let oldSecret: string | undefined;
beforeEach(() => {
  oldSeed = process.env.SEED_CHECKER_SESSIONS;
  oldSecret = process.env.DOGFOOD_SEED_SECRET;
  process.env.SEED_CHECKER_SESSIONS = "true";
  process.env.DOGFOOD_SEED_SECRET = "test-secret";
});
afterEach(() => {
  if (oldSeed === undefined) delete process.env.SEED_CHECKER_SESSIONS;
  else process.env.SEED_CHECKER_SESSIONS = oldSeed;
  if (oldSecret === undefined) delete process.env.DOGFOOD_SEED_SECRET;
  else process.env.DOGFOOD_SEED_SECRET = oldSecret;
});

function seed() {
  const out = seedCheckerSessions(getDb(), "evt_01", NOW);
  if (!out.enabled) throw new Error("seeding reported disabled");
  return out;
}

const tracksOf = (judge: string) => sqlAll<{ t: string }>("SELECT track_id AS t FROM judge_tracks WHERE judge_user_id = ? AND event_id = 'evt_01'", judge).map((r) => r.t);
const isJudge = (id: string) => Boolean(sqlGet("SELECT 1 FROM user_roles WHERE user_id = ? AND event_id = 'evt_01' AND role = 'judge'", id));

/** The session a label's token opens now, and whether that person can judge a track shared with the other judge. */
function expectValidPair() {
  const a = actorForToken(getDb(), checkerToken("judge_a"));
  const b = actorForToken(getDb(), checkerToken("judge_b"));
  expect(a && b, "both judge sessions exist").toBeTruthy();
  for (const actor of [a!, b!]) {
    expect(actor.roles).toContainEqual({ eventId: "evt_01", role: "judge" });
    expect(tracksOf(actor.userId).length).toBeGreaterThan(0);
  }
  expect(a!.userId).not.toBe(b!.userId);
  expect(tracksOf(a!.userId).some((t) => tracksOf(b!.userId).includes(t))).toBe(true);
  return { a: a!.userId, b: b!.userId };
}

describe("checker sessions after the judges change", () => {
  it("a fresh volume keeps the fixture's usual pair (run.py and the hand checks depend on it)", () => {
    const out = seed();
    expect(out.skipped).toEqual([]);
    expect(expectValidPair()).toEqual({ a: "jdg_24", b: "jdg_26" });
  });

  it("removing the busiest judge: the next boot still seeds, and judge_a goes to a judge who still judges", () => {
    seed();
    removeJudge(organizer(), "evt_01", "jdg_24", { reason: "left the event early" });
    expect(isJudge("jdg_24")).toBe(false);
    // their kept reviews still count as assignments, the trap the old choice fell into
    expect(sqlGet<{ n: number }>("SELECT count(*) AS n FROM assignments WHERE judge_user_id = 'jdg_24'")!.n).toBeGreaterThan(0);

    const again = seed(); // threw before the fix
    expect(again.skipped).toEqual([]);
    const pair = expectValidPair();
    expect(pair.a).not.toBe("jdg_24");
    expect(again.changed).toContain("judge_a");
    // the same again on the boot after that: deterministic, nothing changes
    expect(seed().changed).toEqual([]);
  });

  it("removing judge_b, and then judge_a too, keeps finding a valid pair", () => {
    seed();
    removeJudge(organizer(), "evt_01", "jdg_26", { reason: "conflict with a team" });
    seed();
    expect(expectValidPair().b).not.toBe("jdg_26");
    const { a } = expectValidPair();
    removeJudge(organizer(), "evt_01", a, { reason: "had to leave" });
    seed();
    const after = expectValidPair();
    expect([after.a, after.b]).not.toContain(a);
  });

  it("a judge whose tracks change so the pair no longer shares one: a new pair, no failure", () => {
    seed();
    const shared = tracksOf("jdg_24").filter((t) => tracksOf("jdg_26").includes(t));
    expect(shared.length).toBeGreaterThan(0); // positive control: the fixture pair shares a track
    const other = ["trk_01", "trk_02", "trk_03", "trk_04", "trk_05", "trk_06", "trk_07", "trk_08"].find((t) => !tracksOf("jdg_24").includes(t))!;
    setJudgeTracks(organizer(), "evt_01", "jdg_26", { trackIds: [other] });
    seed();
    expectValidPair();
  });

  it("a judge left with no track at all (a row removed by hand) is never picked", () => {
    seed();
    sqlRun("DELETE FROM judge_tracks WHERE judge_user_id = 'jdg_24'");
    expect(isJudge("jdg_24")).toBe(true);
    seed();
    expect(expectValidPair().a).not.toBe("jdg_24");
    expect(chooseCheckerUsers(getDb(), "evt_01").chosen.judge_a).not.toBe("jdg_24");
  });

  it("with no valid pair left the boot still succeeds: judge_b is skipped with one clear warning and its old session is gone", () => {
    seed();
    const keep = "jdg_24";
    sqlRun("DELETE FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge' AND user_id <> ?", keep);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = seed();
      expect(out.identities.map((i) => i.label)).toEqual(["organizer", "judge_a", "participant"]);
      expect(out.skipped).toEqual([{ label: "judge_b", why: expect.stringContaining("no second judge") }]);
    } finally {
      warn.mockRestore();
    }
    expect(actorForToken(getDb(), checkerToken("judge_a"))?.userId).toBe(keep);
    // a skipped label's token opens nothing, rather than an account that is no longer a judge
    expect(actorForToken(getDb(), checkerToken("judge_b"))).toBeNull();
  });

  it("with no judge at all: both judge labels are skipped, the organizer and participant sessions are still made", () => {
    sqlRun("DELETE FROM user_roles WHERE event_id = 'evt_01' AND role = 'judge'");
    const out = seed();
    expect(out.identities.map((i) => i.label)).toEqual(["organizer", "participant"]);
    expect(out.skipped.map((s) => s.label)).toEqual(["judge_a", "judge_b"]);
    expect(actorForToken(getDb(), checkerToken("organizer"))?.userId).toBe("usr_organizer");
  });
});
