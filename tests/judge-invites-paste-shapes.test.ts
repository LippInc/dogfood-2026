import { describe, expect, it } from "vitest";
import { parseInviteLines } from "@/server/dal/judges";
import { HttpError } from "@/server/errors";

// An organizer pastes judges the way an email client or address book hands them over:
// "Alex Chen <alex@example.org>" from a To line, a bare address, or the list's own
// "name, email" form. Each shape makes a judge; a line that cannot be read is named with the
// reason; and a line with no tracks while none are ticked says what to tick, never nothing.

const TRACKS = [
  { id: "trk_a", name: "Security" },
  { id: "trk_b", name: "Health Tech" },
];

function linesOf(text: string, ticked: string[] = ["trk_a"], tracks = TRACKS) {
  return parseInviteLines(text, tracks, ticked);
}

function refusal(text: string, ticked: string[] = ["trk_a"], tracks = TRACKS): string[] {
  try {
    parseInviteLines(text, tracks, ticked);
  } catch (err) {
    if (err instanceof HttpError) return (err.details as { lines: string[] }).lines;
    throw err;
  }
  throw new Error("the list was taken");
}

describe("the shapes a pasted line may take", () => {
  it('reads "Name <email>" as a name and an address, as an email client writes it', () => {
    expect(linesOf("Alex Chen <Alex@Example.org>")).toEqual([{ line: 1, name: "Alex Chen", email: "alex@example.org", trackIds: ["trk_a"] }]);
  });

  it('reads a quoted name with a comma in it, "Chen, Alex" <alex@example.org>, as one name', () => {
    expect(linesOf('"Chen, Alex" <alex@example.org>')).toEqual([{ line: 1, name: "Chen, Alex", email: "alex@example.org", trackIds: ["trk_a"] }]);
  });

  it('reads "<email>" alone, and "Name <email>" followed by the line\'s own tracks', () => {
    expect(linesOf("<bo@example.org>\nCy Lind <cy@example.org>, Security; Health Tech\nDi Ek <di@example.org>\tHealth Tech")).toEqual([
      { line: 1, name: "", email: "bo@example.org", trackIds: ["trk_a"] },
      { line: 2, name: "Cy Lind", email: "cy@example.org", trackIds: ["trk_a", "trk_b"] },
      { line: 3, name: "Di Ek", email: "di@example.org", trackIds: ["trk_b"] },
    ]);
  });

  it("several addresses pasted from one To line, separated by commas, still read one per line when each has its own line", () => {
    const text = "Alex Chen <alex@example.org>,\nMira Ek <mira@example.org>;";
    expect(linesOf(text).map((l) => [l.name, l.email])).toEqual([
      ["Alex Chen", "alex@example.org"],
      ["Mira Ek", "mira@example.org"],
    ]);
  });

  it("keeps the shapes that worked before: an address alone, and name then address by comma or tab", () => {
    expect(linesOf("jon@example.org\nMira Ek, mira@example.org\nBo Lind\tbo@example.org")).toEqual([
      { line: 1, name: "", email: "jon@example.org", trackIds: ["trk_a"] },
      { line: 2, name: "Mira Ek", email: "mira@example.org", trackIds: ["trk_a"] },
      { line: 3, name: "Bo Lind", email: "bo@example.org", trackIds: ["trk_a"] },
    ]);
  });

  it("reads a name and an address separated only by spaces", () => {
    expect(linesOf("Mira Ek mira@example.org, Health Tech")).toEqual([{ line: 1, name: "Mira Ek", email: "mira@example.org", trackIds: ["trk_b"] }]);
  });

  it("names a line it cannot read, with the reason, and makes nothing", () => {
    expect(refusal("Alex Chen <not-an-address>\nOk <ok@example.org>\nTwo <a@example.org> <b@example.org>\nBad <x@y>")).toEqual([
      "line 1: the part in <...> is not an email address: not-an-address",
      "line 3: two addresses on one line",
      "line 4: not an email address: x@y",
    ]);
  });
});

describe("a line with no tracks while no track is ticked", () => {
  it("says plainly what to tick, naming the lines, instead of one bare line each", () => {
    const lines = refusal("Alex Chen <alex@example.org>\nMira Ek, mira@example.org\nCy <cy@example.org>, Security", []);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^lines 1 and 2: no tracks\. Tick the tracks under "Tracks, for every line that names none", or add them after the address/);
  });

  it("lines that carry their own tracks are read with nothing ticked", () => {
    expect(linesOf("Cy <cy@example.org>, Security\nDi, di@example.org, Health Tech", [])).toEqual([
      { line: 1, name: "Cy", email: "cy@example.org", trackIds: ["trk_a"] },
      { line: 2, name: "Di", email: "di@example.org", trackIds: ["trk_b"] },
    ]);
  });

  it("an event with one track gives it to every line that names none, ticked or not", () => {
    expect(linesOf("Alex Chen <alex@example.org>", [], [TRACKS[0]])).toEqual([{ line: 1, name: "Alex Chen", email: "alex@example.org", trackIds: ["trk_a"] }]);
  });
});
