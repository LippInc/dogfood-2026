import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { getJudgeScores } from "@/server/dal/scores";
import { actorForToken } from "@/server/session";

// Written before the feature (CLAUDE.md "Tests"): the same peer URL answers 403 to
// judge_b and 200 with rows to judge_a, and never falls back to the caller's rows.

const NOW = "2026-09-26T12:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function actor(label: "organizer" | "judge_a" | "judge_b" | "participant") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  const token = seeded.identities.find((i) => i.label === label)!.token;
  return actorForToken(h.db, token)!;
}

function status(fn: () => unknown): number {
  try {
    fn();
    return 200;
  } catch (err) {
    return (err as { status?: number }).status ?? 500;
  }
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

describe("peer scores: one URL, two judges", () => {
  it("judge_a reading jdg_24 (itself) gets its 11 reviews", () => {
    const a = actor("judge_a");
    expect(a.userId).toBe("jdg_24");
    const result = getJudgeScores(a, "jdg_24");
    expect(result.judge.id).toBe("jdg_24");
    expect(result.reviews).toHaveLength(11);
    expect(result.reviews.every((r) => r.items.length > 0)).toBe(true);
  });

  it("judge_b reading jdg_24 is refused with 403, not served its own rows", () => {
    const b = actor("judge_b");
    expect(b.userId).toBe("jdg_26");
    let caught: { status?: number; code?: string } | null = null;
    try {
      getJudgeScores(b, "jdg_24");
    } catch (err) {
      caught = err as { status?: number; code?: string };
    }
    expect(caught?.status).toBe(403);
    expect(caught?.code).toBe("not_your_scores");
  });

  it("positive controls: judge_b on its own scores is 200; no requested id means own scores", () => {
    const b = actor("judge_b");
    expect(getJudgeScores(b, "jdg_26").reviews).toHaveLength(10);
    expect(getJudgeScores(b, null).judge.id).toBe("jdg_26");
    expect(getJudgeScores(actor("judge_a"), null).reviews).toHaveLength(11);
  });

  it("an empty or unknown requested id is a refusal, never the caller's own rows", () => {
    const b = actor("judge_b");
    expect(status(() => getJudgeScores(b, ""))).toBe(403);
    expect(status(() => getJudgeScores(b, "jdg_999"))).toBe(403);
    expect(status(() => getJudgeScores(b, "JDG_26"))).toBe(403);
  });

  it("a participant and an organizer are refused; no session is 401", () => {
    expect(status(() => getJudgeScores(actor("participant"), null))).toBe(403);
    expect(status(() => getJudgeScores(actor("participant"), "jdg_24"))).toBe(403);
    expect(status(() => getJudgeScores(actor("organizer"), "jdg_24"))).toBe(403);
    expect(status(() => getJudgeScores(null, "jdg_24"))).toBe(401);
    expect(status(() => getJudgeScores(null, null))).toBe(401);
  });

  it("each 403 leaves one authz.refused audit row naming the refused judge id", () => {
    const b = actor("judge_b");
    const before = (h.sqlite.prepare("select count(*) n from audit_log where action = 'authz.refused'").get() as { n: number }).n;
    status(() => getJudgeScores(b, "jdg_24"));
    const rows = h.sqlite
      .prepare("select actor_user_id, target_id, after from audit_log where action = 'authz.refused' order by id")
      .all() as { actor_user_id: string; target_id: string; after: string }[];
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)).toMatchObject({ actor_user_id: "jdg_26", target_id: "jdg_24" });
    expect(JSON.parse(rows.at(-1)!.after)).toMatchObject({ attempted: "scores.read_judge", code: "not_your_scores" });
  });
});
