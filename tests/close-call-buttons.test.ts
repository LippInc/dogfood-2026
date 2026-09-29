import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TrackCloseCall } from "@/server/dal";

// The close-call card on the organizer's Results page and Overview offers only the actions that can work. A stale
// choice on a track the scores now call clearly would have "Keep the ranking's winner" answer 409 not_a_close_call
// every time, so there it offers only the undo, with a line saying why.

vi.mock("@/app/organize/[event]/decision-actions", () => {
  const noop = async () => ({ ok: true });
  return Object.fromEntries(
    ["acceptAction", "judgesDecisionAction", "keepRankingAction", "undoCloseCallAction", "mergeAction", "notDuplicateAction", "overrideAction", "publishAction", "topUpAction", "undoAcceptAction", "undoNotDuplicateAction", "undoOverrideAction", "unmergeAction"].map((k) => [k, noop]),
  );
});
const { CloseCallBody } = await import("@/app/organize/[event]/decisions");
const { closeCallsHeading } = await import("@/app/organize/[event]/results/close-call-heading");

const projects = [
  { id: "p1", title: "Slow Trail", score: 4.4, se: 0.1 },
  { id: "p2", title: "Salt Ferry", score: 3.9, se: 0.1 },
];
function call(over: Partial<TrackCloseCall>): TrackCloseCall {
  return { trackId: "t1", trackName: "Health", projects, top: ["p1"], tieBroken: null, callable: false, close: ["p1", "p2"], signal: true, required: true, choice: null, stale: null, ...over };
}
const render = (c: TrackCloseCall) => renderToStaticMarkup(h(CloseCallBody, { c, eventSlug: "e", published: false }));

describe("the close-call card offers only what works", () => {
  it("a stale choice on a track the scores now call clearly: only the undo, and why", () => {
    const html = render(
      call({
        callable: true,
        close: ["p1"],
        required: false,
        choice: { trackId: "t1", mode: "judges", top: ["p1"], winnerId: "p2", reason: "Deliberated.", at: "2026-09-29T10:00:00Z" },
        stale: "the scores now name the winner clearly, so the judges' decision no longer applies",
      }),
    );
    expect(html).toContain("Undo my earlier choice");
    expect(html).not.toContain("Keep the ranking");
    expect(html).not.toContain("Record the judges");
    expect(html).toContain("There is no close call left to settle here, so undo it to clear it.");
    expect(html).toContain("Clear from the scores now");
    expect(html).not.toContain("Too close to call");
  });

  it("positive control: a stale choice on a track still too close to call offers keep, record and undo", () => {
    const html = render(
      call({ choice: { trackId: "t1", mode: "keep", top: ["p2"], at: "2026-09-29T10:00:00Z" }, stale: "the ranking's first place changed since the choice was made" }),
    );
    expect(html).toContain("Keep the ranking&#x27;s winner, Slow Trail");
    expect(html).toContain("Record the judges");
    expect(html).toContain("Undo my earlier choice");
    expect(html).toContain("Choose again, or undo it.");
    expect(html).toContain("Too close to call from the scores");
  });

  it("names the close projects with their score and ±, never a chance of being first", () => {
    const html = render(call({}));
    expect(html).toContain("Slow Trail 4.40 ± 0.10, Salt Ferry 3.90 ± 0.10");
    expect(html).not.toMatch(/chance/i);
    // the only percentage is the rule's own line
    expect(html.match(/\d+ %/g)).toEqual(["95 %", "95 %"]);
  });

  it("an exact tie at the top that the tie-break splits: keeping names the tie-break's winner, as the results publish it", () => {
    const tied = [
      { id: "p1", title: "Slow Trail", score: 4.2, se: 0.1 },
      { id: "p2", title: "Salt Ferry", score: 4.2, se: 0.1 },
    ];
    const html = render(call({ projects: tied, top: ["p1", "p2"], tieBroken: { winnerId: "p2", criterion: "Impact" } }));
    expect(html).toContain("Keep the ranking&#x27;s winner, Salt Ferry (tie with Slow Trail broken by Impact)");
    expect(html).not.toContain(", tied");
    // positive control: with no tie-break set the top stays joint, and the card says so
    const joint = render(call({ projects: tied, top: ["p1", "p2"], tieBroken: null }));
    expect(joint).toContain("Keep the ranking&#x27;s winner, Slow Trail and Salt Ferry, tied");
    // and the kept card names the same winner
    const kept = render(call({ projects: tied, top: ["p1", "p2"], tieBroken: { winnerId: "p2", criterion: "Impact" }, choice: { trackId: "t1", mode: "keep", top: ["p1", "p2"], at: "2026-09-29T10:00:00Z" } }));
    expect(kept).toContain("Kept: Salt Ferry (tie with Slow Trail broken by Impact) is published as the winner.");
  });

  it("the Results page heading counts only tracks too close to call now, not a kept choice on a track the scores now decide", () => {
    const kept = { trackId: "t2", mode: "keep" as const, top: ["p1"], at: "2026-09-29T10:00:00Z" };
    // one track close now, one with a kept choice that has since become clear: before, the heading said 2 tracks
    expect(closeCallsHeading([call({}), call({ trackId: "t2", callable: true, close: ["p1"], required: false, choice: kept })])).toBe(
      "Close calls: 1 track too close to call from the scores",
    );
    expect(closeCallsHeading([call({ callable: true, close: ["p1"], required: false, choice: kept })])).toBe("Close calls: no track too close to call from the scores now");
    // positive control: two tracks close now count as two
    expect(closeCallsHeading([call({}), call({ trackId: "t2" })])).toBe("Close calls: 2 tracks too close to call from the scores");
    // and the now-clear card says so, with the kept choice as it stands
    const html = render(call({ callable: true, close: ["p1"], required: false, choice: kept }));
    expect(html).toContain("Clear from the scores now");
    expect(html).toContain("Kept: Slow Trail is published as the winner.");
  });
});
