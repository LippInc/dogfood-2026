import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { votesCount, votesIn } from "@/lib/format";

// An organizer reads how many community votes are in as "8 votes are in", never "8 ballots" (jargon)
// and never "8 people have voted": ballots through the open link cannot prove they come from
// different people. "Ballot" stays where it names the thing itself (a ballot's order, open-link ballots).

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("how many votes are in, in the organizer's words", () => {
  it("says none, one and many properly", () => {
    expect(votesIn(0)).toBe("no votes are in yet");
    expect(votesIn(1)).toBe("1 vote is in");
    expect(votesIn(8)).toBe("8 votes are in");
    expect(votesCount(0)).toBe("no votes");
    expect(votesCount(1)).toBe("1 vote");
    expect(votesCount(8)).toBe("8 votes");
  });

  it("the Overview's publish box and its closed-vote fact use them; no organizer screen counts 'ballots'", () => {
    const decisions = read("src/app/organize/[event]/decisions.tsx");
    expect(decisions).toContain("; ${votesIn(vote.ballots)}. Publishing closes it");
    const overview = read("src/app/organize/[event]/page.tsx");
    expect(overview).toContain("closed, ${votesCount(o.vote.ballots)}");
    const voting = read("src/app/organize/[event]/voting/page.tsx");
    expect(voting).toContain('{v.turnout.ballots === 1 ? "vote" : "votes"} counted');
    // a count followed by the word ballot(s), in any of the organizer's screens
    const counted = /"ballot" : "ballots"|plural\([^)]*"ballot"\)|\}\s*ballots\b|ballots counted/;
    // known-bad control: the three sentences as they were before are caught
    for (const old of [
      "with ${vote.ballots} ${vote.ballots === 1 ? \"ballot\" : \"ballots\"}. Publishing",
      "closed, ${plural(o.vote.ballots, \"ballot\")}",
      "<span>ballots counted</span>",
      "{g.voters.length} ballots, same address and browser",
    ])
      expect(old, old).toMatch(counted);
    for (const [name, text] of [
      ["decisions", decisions],
      ["overview", overview],
      ["voting", voting],
    ])
      expect(text.match(counted)?.[0] ?? null, name).toBeNull();
    // "ballot" as the thing itself stays
    expect(voting).toContain("Open-link ballots");
  });
});
