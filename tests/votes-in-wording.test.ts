import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { votersCount, votersIn } from "@/lib/format";

// An organizer reads how many have voted as "8 voters so far", never "8 ballots" (jargon), never
// "8 votes" (a vote is one pick: 3 per voter by default, and every project's tally counts votes, so
// "8 votes" over tallies adding up to 24 reads as a broken count), and never "8 people have voted":
// voters through the open link cannot prove they are different people. "Ballot" stays where it names
// the thing itself (a ballot's order, open-link ballots).

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("how many votes are in, in the organizer's words", () => {
  it("says none, one and many properly", () => {
    expect(votersIn(0)).toBe("no voters yet");
    expect(votersIn(1)).toBe("1 voter so far");
    expect(votersIn(8)).toBe("8 voters so far");
    expect(votersCount(0)).toBe("no voters");
    expect(votersCount(1)).toBe("1 voter");
    expect(votersCount(8)).toBe("8 voters");
  });

  it("the Overview's publish box and its closed-vote fact use them; no organizer screen counts 'ballots'", () => {
    const decisions = read("src/app/organize/[event]/decisions.tsx");
    expect(decisions).toContain("; ${votersIn(vote.ballots)}. Publishing closes it");
    const overview = read("src/app/organize/[event]/page.tsx");
    expect(overview).toContain("closed, ${votersCount(o.vote.ballots)}");
    const voting = read("src/app/organize/[event]/voting/page.tsx");
    expect(voting).toContain('{v.turnout.ballots === 1 ? "voter" : "voters"} counted');
    expect(voting).toContain("{g.voters.length} voters, same address and browser");
    // the ambiguous count that came before this wording: a ballot count called "votes"
    for (const text of [decisions, overview, voting]) expect(text).not.toMatch(/votes are in|"votes"\} counted|\{g\.voters\.length\} votes,/);
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
