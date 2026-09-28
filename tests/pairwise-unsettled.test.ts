import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDemoOrganizer, seedCheckerSessions } from "@/server/checker";
import { openDatabase, setHandleForTests, type Handle } from "@/server/db/client";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { runMigrations } from "@/server/db/migrate";
import { auditLog, events, normalizationRuns } from "@/server/db/schema";
import { acceptUnderReviewed, mergeDuplicate, setJudgeOverride } from "@/server/dal/decisions";
import { getPublishedResults, publishResults } from "@/server/dal/results";
import { getOverview } from "@/server/dal/overview";
import { getPairwiseRanking, getPairwiseState, pickPairwise, setJudgingMode } from "@/server/dal/pairwise";
import { actorForToken } from "@/server/session";

// A pairwise ranking fit that stops at its step limit before settling (JUDGING.md "Pairwise
// mode"): the organizer is told before publishing, publishing it needs a written reason,
// and the reason is stored with the run and shown on the results. On real data the fit
// settles in a handful of steps, so here the engine is made to report that it did not.

const control = vi.hoisted(() => ({ unsettle: false }));
vi.mock("@/server/judging/pairwise", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/server/judging/pairwise")>();
  return {
    ...real,
    fitPairwise: (...args: Parameters<typeof real.fitPairwise>) => {
      const fit = real.fitPairwise(...args);
      return control.unsettle ? { ...fit, converged: false, iterations: 100 } : fit;
    },
  };
});

const NOW = "2026-09-27T08:00:00.000Z";
let h: Handle;
const saved = { flag: process.env.SEED_CHECKER_SESSIONS };

function checker(label: "organizer" | "judge_a") {
  const seeded = seedCheckerSessions(h.db, "evt_01", NOW);
  if (!seeded.enabled) throw new Error("checker sessions disabled in test");
  return actorForToken(h.db, seeded.identities.find((i) => i.label === label)!.token)!;
}

function outcome(fn: () => unknown): { status: number; code?: string } {
  try {
    fn();
    return { status: 200 };
  } catch (err) {
    const e = err as { status?: number; code?: string };
    return { status: e.status ?? 500, code: e.code };
  }
}

/** Pairwise mode, one answer, every decision settled: only the fit can stand in the way. */
function readyToPublish() {
  const org = checker("organizer");
  setJudgingMode(org, "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
  const judge = checker("judge_a");
  const t = getPairwiseState(judge, "evt_01").tracks.find((x) => x.current)!;
  pickPairwise(judge, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, outcome: "left" });
  mergeDuplicate(org, "evt_01", { keepId: "prj_07", duplicateId: "prj_41" });
  acceptUnderReviewed(org, "evt_01", { projectId: "prj_19", reason: "only one judge compared it" });
  setJudgeOverride(org, "evt_01", { judgeUserId: "jdg_07", mode: "exclude", reason: "flat scores" });
  return org;
}

beforeEach(() => {
  control.unsettle = false;
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

describe("publishing a pairwise ranking whose fit did not settle", () => {
  it("is shown to the organizer first, refused without a reason (409 fit_not_settled), and nothing is stored", () => {
    const org = readyToPublish();
    control.unsettle = true;
    expect(getPairwiseRanking(org, "evt_01")).toMatchObject({ converged: false, iterations: 100 });
    expect(getOverview(org, "evt_01").pairwise).toMatchObject({ unsettled: { iterations: 100 }, publishedUnsettled: null });
    expect(outcome(() => publishResults(org, "evt_01"))).toEqual({ status: 409, code: "fit_not_settled" });
    expect(outcome(() => publishResults(org, "evt_01", { reason: "  " }))).toMatchObject({ status: 422 });
    expect(outcome(() => publishResults(org, "evt_01", { reason: "ok" }))).toMatchObject({ status: 422 });
    expect(h.db.select().from(events).where(eq(events.id, "evt_01")).get()!.resultsPublishedAt).toBeNull();
    expect(h.db.select().from(normalizationRuns).all()).toHaveLength(0);
  });

  it("with a reason, stores it with the run, in the audit row and on the published results", () => {
    const org = readyToPublish();
    control.unsettle = true;
    const reason = "prize giving starts in ten minutes; the order has not changed in an hour";
    expect(outcome(() => publishResults(org, "evt_01", { reason })).status).toBe(200);
    const published = getPublishedResults("evt_01");
    if (!published.published) throw new Error("not published");
    expect(published.unsettled).toEqual({ iterations: 100, reason });
    const run = h.db.select().from(normalizationRuns).where(eq(normalizationRuns.id, published.runId)).get()!;
    expect(run.params).toMatchObject({ converged: false, iterations: 100, unsettled: { iterations: 100, reason } });
    const audit = h.db.select().from(auditLog).where(and(eq(auditLog.action, "results.publish"), eq(auditLog.targetId, published.runId))).get()!;
    expect(audit.after).toMatchObject({ converged: false, unsettled: { iterations: 100, reason } });
    expect(getOverview(org, "evt_01").pairwise).toMatchObject({ publishedUnsettled: { iterations: 100, reason } });
  });

  it("positive control: a fit that settled publishes without a reason, and a reason given anyway is not stored", () => {
    const org = readyToPublish();
    expect(getPairwiseRanking(org, "evt_01").converged).toBe(true);
    expect(getOverview(org, "evt_01").pairwise).toMatchObject({ unsettled: null });
    expect(outcome(() => publishResults(org, "evt_01", { reason: "just in case" })).status).toBe(200);
    const published = getPublishedResults("evt_01");
    if (!published.published) throw new Error("not published");
    expect(published.unsettled).toBeNull();
    expect(h.db.select().from(normalizationRuns).get()!.params).toMatchObject({ converged: true });
  });
});
