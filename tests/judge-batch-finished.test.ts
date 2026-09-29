import { describe, expect, it } from "vitest";
import { batchFinished } from "@/app/judge/[event]/save-next";

// A judge at the end of the batch (2026-09-29) pressed Save and open next and saw nothing happen. The finished
// state shows only when every project that counts is scored, and goes away when a score is cleared.

describe("the judge's finished batch", () => {
  const s = (scored: boolean, recused = false) => ({ scored, recused });

  it("is finished when every project is scored", () => {
    expect(batchFinished([s(true), s(true), s(true)])).toBe(true);
  });

  it("is not finished while any project that counts is unfinished", () => {
    expect(batchFinished([s(true), s(false), s(true)])).toBe(false);
    expect(batchFinished([s(false)])).toBe(false);
  });

  it("counts a recused project as done, scored or not", () => {
    expect(batchFinished([s(true), s(false, true), s(true)])).toBe(true);
  });

  it("goes back to unfinished when a score is cleared", () => {
    const slots = [s(true), s(true)];
    expect(batchFinished(slots)).toBe(true);
    slots[1] = s(false);
    expect(batchFinished(slots)).toBe(false);
  });

  it("has nothing to finish in an empty or wholly recused batch", () => {
    expect(batchFinished([])).toBe(false);
    expect(batchFinished([s(false, true), s(true, true)])).toBe(false);
  });
});
