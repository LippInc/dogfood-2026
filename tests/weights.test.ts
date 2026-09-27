import { describe, expect, it } from "vitest";
import { weightShares } from "@/lib/format";

describe("weightShares", () => {
  it("shows simple fractions when every share is one", () => {
    expect(weightShares([1, 1, 1])).toEqual(["⅓", "⅓", "⅓"]);
    expect(weightShares([1, 4])).toEqual(["⅕", "⅘"]);
    expect(weightShares([2, 1, 1])).toEqual(["½", "¼", "¼"]);
  });

  it("known-bad mix: when any share has no simple fraction, every share is a percentage", () => {
    // 1/15, 2/15 and 3/15 = 1/5: the last alone has a glyph, so none may use one.
    expect(weightShares([1, 2, 3, 1, 2, 3, 1, 2])).toEqual(["7 %", "13 %", "20 %", "7 %", "13 %", "20 %", "7 %", "13 %"]);
    expect(weightShares([1, 1, 1, 1, 1, 1, 1])).toEqual(Array(7).fill("14 %"));
  });

  it("a single criterion carries all the weight", () => {
    expect(weightShares([3])).toEqual(["100 %"]);
  });
});
