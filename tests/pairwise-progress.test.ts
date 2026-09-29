import { describe, expect, it } from "vitest";
import { getPairwiseState, pairwiseProgress, pickPairwise, setJudgingMode } from "@/server/dal/pairwise";
import { requireEvent } from "@/server/dal/events";
import { actorById, sqlAll, withFixtureEvent } from "./support/fixture-harness";

// The Overview's pairwise progress is the sum of every judge's own lists: placed, of all their projects, and
// the answers given. Checked against each judge's own state after answers from several judges.

const h = withFixtureEvent();

describe("pairwise progress on the Overview", () => {
  it("adds up every judge's placed, total and answers", { timeout: 30_000 }, () => {
    setJudgingMode(actorById("usr_organizer"), "evt_01", { mode: "pairwise", reason: "try the better-of-two mode" });
    const judges = sqlAll<{ id: string }>("SELECT DISTINCT judge_user_id AS id FROM assignments WHERE event_id = 'evt_01' ORDER BY judge_user_id").map((r) => r.id);
    expect(judges.length).toBeGreaterThan(2);
    // three judges answer a few questions each, so the sums mix judges with and without answers
    judges.slice(0, 3).forEach((id, n) => {
      const actor = actorById(id);
      for (let i = 0; i < n + 2; i++) {
        const t = getPairwiseState(actor, "evt_01").tracks.find((x) => x.current);
        if (!t) break;
        pickPairwise(actor, "evt_01", { trackId: t.trackId, left: t.current!.left.id, right: t.current!.right.id, outcome: i % 2 ? "left" : "right" });
      }
    });
    const expected = { placed: 0, total: 0, answers: 0 };
    for (const id of judges) {
      for (const t of getPairwiseState(actorById(id), "evt_01").tracks) {
        expected.placed += t.placed;
        expected.total += t.total;
        expected.answers += t.answered;
      }
    }
    expect(expected.answers).toBeGreaterThan(1);
    expect(pairwiseProgress(h().db, requireEvent(h().db, "evt_01"))).toEqual(expected);
  });
});
