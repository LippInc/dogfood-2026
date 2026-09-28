import { describe, expect, it } from "vitest";
import { setJudgeRanking } from "@/server/dal/judges";
import { getJudgeConsole } from "@/server/dal/reviews";
import { latestAudit } from "@/server/dal/audit-log";
import { getDb } from "@/server/db/client";
import { actorById, addUser, auditRows, expectHttpError, organizer, sqlRun, withFixtureEvent } from "./support/fixture-harness";

// The judges' own "ranking so far" in the console is on by default; the organizer can turn it
// off (against ranking bias) from Settings, "How judges judge". Before this, the console read
// settings.judgeRanking but nothing could set it.

withFixtureEvent();

const JUDGE = "jdg_24";
const shows = () => getJudgeConsole(actorById(JUDGE), "evt_01").showRanking;
const rankingRows = () => auditRows().filter((r) => r.action === "event.judge_ranking");

describe("setJudgeRanking", () => {
  it("is on by default; the organizer turns it off and on, one audit row each, a repeat writes none", () => {
    expect(shows()).toBe(true);

    expect(setJudgeRanking(organizer(), "evt_01", { show: false })).toEqual({ show: false, changed: true });
    expect(shows()).toBe(false);
    expect(rankingRows()).toHaveLength(1);
    expect(rankingRows()[0]).toMatchObject({ before: { show: true }, after: { show: false }, actorUserId: "usr_organizer" });

    expect(setJudgeRanking(organizer(), "evt_01", { show: false })).toEqual({ show: false, changed: false });
    expect(rankingRows()).toHaveLength(1);

    setJudgeRanking(organizer(), "evt_01", { show: true });
    expect(shows()).toBe(true);
    expect(rankingRows()).toHaveLength(2);
  });

  it("reads as a sentence in the audit log", () => {
    setJudgeRanking(organizer(), "evt_01", { show: false });
    const line = latestAudit(getDb(), "evt_01", 1, ["event.judge_ranking"])[0]!;
    expect(line.parts.map((p) => p.text).join("")).toContain("hid each judge's own ranking so far");
  });

  it("refuses no session with 401, a judge and an outsider with 403, and a missing flag with 422", () => {
    expectHttpError(() => setJudgeRanking(null, "evt_01", { show: false }), 401, "unauthenticated");
    expectHttpError(() => setJudgeRanking(actorById(JUDGE), "evt_01", { show: false }), 403, "not_an_organizer");
    const outsider = addUser("usr_out", "out@example.org", "Out");
    expectHttpError(() => setJudgeRanking(outsider, "evt_01", { show: false }), 403, "not_an_organizer");
    expectHttpError(() => setJudgeRanking(organizer(), "evt_01", {}), 422, "invalid");
    expect(shows()).toBe(true);
    expect(rankingRows()).toHaveLength(0);
  });

  it("is final once the results are published (409)", () => {
    sqlRun("UPDATE events SET results_published_at = '2026-09-26T13:00:00.000Z' WHERE id = 'evt_01'");
    expectHttpError(() => setJudgeRanking(organizer(), "evt_01", { show: false }), 409, "results_published");
  });
});
