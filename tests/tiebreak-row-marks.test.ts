import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RowChangeMarks, tieBrokenByOf } from "@/components/results/after-the-fact";
import { competitionPlaces } from "@/lib/places";
import { breakTies } from "@/server/judging/tiebreak";

// The per-track rows and the overall order draw their row notes through RowChangeMarks, fed by tieBrokenByOf. A
// three-way exact tie the criterion splits 4, 4, 1 leaves the first two joint at 1.5 (Small Loom and Small Relay in
// the review): only the third's place was decided by the criterion, so only it may say "tie broken by".

const mark = (tieBrokenBy: ReturnType<typeof tieBrokenByOf>) =>
  renderToStaticMarkup(h(RowChangeMarks, { projectHref: "/p", teamChangedAt: null, tieBrokenBy, moves: undefined }));

describe("the row note on the per-track results and the overall order", () => {
  const rows = breakTies(
    [
      { projectId: "loom", score: 3, tie: null as number | null },
      { projectId: "relay", score: 3, tie: null as number | null },
      { projectId: "third", score: 3, tie: null as number | null },
    ],
    new Map([
      ["loom", 4],
      ["relay", 4],
      ["third", 1],
    ]),
  );
  const places = competitionPlaces(rows);
  const tieBreak = { criterion: "Functionality" };

  it("says nothing beside the two places the criterion left joint (1.5 and 1.5), and the note beside the one it decided", () => {
    // all three carry the raw flag: the criterion did move them, which is why the place has to be asked too
    expect(rows.map((r) => r.tieBroken)).toEqual([true, true, true]);
    expect(places.map((p) => p.joint)).toEqual([true, true, false]);
    const notes = rows.map((r, k) => mark(tieBrokenByOf(r, tieBreak, places[k]!)));
    expect(notes[0]).not.toContain("tie broken by");
    expect(notes[1]).not.toContain("tie broken by");
    expect(notes[2]).toContain("Exactly tied on score; tie broken by Functionality");
    expect(notes[2]).toContain("plain average on Functionality");
    expect(notes[2]).toMatch(/<span class="tnum">1\.00<\/span>/);
    for (const n of notes) expect(n).not.toContain("Tied on score");
  });

  it("control: a two-way tie the criterion splits says it beside both places", () => {
    const two = breakTies(
      [
        { projectId: "a", score: 3, tie: null as number | null },
        { projectId: "b", score: 3, tie: null as number | null },
      ],
      new Map([
        ["a", 4],
        ["b", 2],
      ]),
    );
    const p = competitionPlaces(two);
    expect(two.map((r, k) => mark(tieBrokenByOf(r, tieBreak, p[k]!)).includes("tie broken by Functionality"))).toEqual([true, true]);
  });

  it("is fed the row's place in its track on both pages", () => {
    const callers = {
      "src/app/events/[event]/results/page.tsx": "tieBrokenByOf(r, results.tieBreak, p)",
      "src/components/results/overall-list.tsx": "tieBrokenByOf(r, results.tieBreak, e.trackPlace)",
    };
    for (const [f, call] of Object.entries(callers)) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src, f).toContain(call);
      expect(src, f).not.toContain("Tied on score");
    }
  });
});
