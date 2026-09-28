import { describe, expect, it } from "vitest";
import { saveAndNextTarget, type Slot } from "@/app/judge/[event]/save-next";

// Save and open next, in the judge console. A tester who had scored all 11 projects pressed it on the last
// one and was taken back to the first with nothing saying the batch was done; the first fix then stopped it
// moving at all once everything was scored, so a judge revising scores could no longer walk the batch with
// Ctrl+Enter (caught by the keyboard pass). The rule: the next unfinished project; once all are scored, the
// next one in order with the batch-done line, and on the last one stay with that line instead of wrapping.

const open = (scored: boolean): Slot => ({ open: true, scored });
const closed: Slot = { open: false, scored: true };

describe("saveAndNextTarget", () => {
  it("goes to the next unfinished project after this one", () => {
    expect(saveAndNextTarget([open(true), open(true), open(false), open(false)], 0)).toEqual({ to: 2, batchDone: false });
  });

  it("looks past the end for an unfinished project before this one", () => {
    expect(saveAndNextTarget([open(false), open(true), open(true)], 2)).toEqual({ to: 0, batchDone: false });
  });

  it("skips projects it cannot score (recused, or read-only after the close)", () => {
    expect(saveAndNextTarget([open(true), { open: false, scored: false }, open(false)], 0)).toEqual({ to: 2, batchDone: false });
  });

  it("once every project is scored, still walks on in order and says the batch is done", () => {
    expect(saveAndNextTarget([open(true), open(true), open(true)], 0)).toEqual({ to: 1, batchDone: true });
  });

  it("on the last project of a scored batch, stays and says so instead of wrapping to the first", () => {
    expect(saveAndNextTarget([open(true), open(true), open(true)], 2)).toEqual({ to: 2, batchDone: true });
  });

  it("read-only browsing after the close moves on in order and wraps, as before", () => {
    expect(saveAndNextTarget([closed, closed, closed], 2)).toEqual({ to: 0, batchDone: false });
    expect(saveAndNextTarget([closed, closed, closed], 0)).toEqual({ to: 1, batchDone: false });
  });

  it("a one-project batch that is scored stays on it", () => {
    expect(saveAndNextTarget([open(true)], 0)).toEqual({ to: 0, batchDone: true });
  });
});
