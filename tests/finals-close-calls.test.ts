import { describe, expect, it } from "vitest";
import { getCloseCalls, settleCloseCall } from "@/server/dal/close-calls";
import { openFinals } from "@/server/dal/finals";
import { expectHttpError, organizer, withFixtureEvent } from "./support/fixture-harness";

// The published order is the engine's scores, the tie-break, the finals, then the judges' decision, which applies only
// to a track without finals (JUDGING.md, "Close calls and the judges' decision" and "Finals"). So a track that holds
// finals has no close call and takes no judges' decision; a track without finals keeps both (the positive controls).
// Every track of the sample event is too close to call (JUDGING.md), which is what the controls rest on.

withFixtureEvent();

const calls = () => getCloseCalls(organizer(), "evt_01").tracks;
const challenger = (trackId: string) => {
  const c = calls().find((t) => t.trackId === trackId)!;
  return c.close.find((id) => !c.top.includes(id))!;
};
const REASON = "The judges found its demo worked end to end.";

describe("close calls and finals", () => {
  it("control: without finals, trk_01 is a close call and takes a judges' decision", () => {
    expect(calls().map((t) => t.trackId)).toContain("trk_01");
    const winner = challenger("trk_01");
    expect(winner).toBeTruthy();
    settleCloseCall(organizer(), "evt_01", "trk_01", { mode: "judges", winnerId: winner, reason: REASON });
    expect(calls().find((t) => t.trackId === "trk_01")!.choice).toMatchObject({ mode: "judges", winnerId: winner });
  });

  it("a track that holds finals has no close call, and recording a judges' decision for it is 409 finals_track", () => {
    const winner = challenger("trk_01");
    const others = calls().map((t) => t.trackId).filter((id) => id !== "trk_01");
    expect(others.length).toBeGreaterThan(0);
    openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
    // skipped by the check: no "too close to call", nothing for publishing to wait on; the other tracks unchanged
    expect(calls().map((t) => t.trackId)).toEqual(others);
    expectHttpError(() => settleCloseCall(organizer(), "evt_01", "trk_01", { mode: "judges", winnerId: winner, reason: REASON }), 409, "finals_track");
    expectHttpError(() => settleCloseCall(organizer(), "evt_01", "trk_01", { mode: "keep" }), 409, "finals_track");
    // positive control: a track without finals still takes one
    const other = others[0]!;
    settleCloseCall(organizer(), "evt_01", other, { mode: "judges", winnerId: challenger(other), reason: REASON });
    expect(calls().find((t) => t.trackId === other)!.choice).toMatchObject({ mode: "judges" });
  });

  it("a judges' decision stored before the track's finals opened is not applied: the track leaves the close calls", () => {
    settleCloseCall(organizer(), "evt_01", "trk_01", { mode: "judges", winnerId: challenger("trk_01"), reason: REASON });
    openFinals(organizer(), "evt_01", { track: "trk_01", n: 3 });
    expect(calls().some((t) => t.trackId === "trk_01")).toBe(false);
  });

  it("a round over every track takes every track with finalists out of the close calls", () => {
    expect(calls().length).toBeGreaterThan(0);
    openFinals(organizer(), "evt_01", { n: 3 });
    expect(calls()).toEqual([]);
  });
});
