import { describe, expect, it } from "vitest";
import { startIndex } from "@/lib/judge-start";

// Where the judge console opens with no ?project= in the address. A returning judge used to land on
// batch position 1 even when it was recused (a project they may not score): now the console opens the
// first project that still needs a score, else the first one not recused. ?project= works as before.

type S = "pending" | "done" | "recused";
const item = (id: string, status: S, readOnly: string | null = null) => ({ project: { id }, status, readOnly });

describe("the judge console's opening project", () => {
  it("opens the first project that still needs a score, skipping recused, done and read-only ones", () => {
    const items = [item("p1", "recused", "You declared a conflict"), item("p2", "done"), item("p3", "pending", "not in your tracks any more"), item("p4", "pending")];
    expect(startIndex(items, null)).toBe(3);
  });

  it("with nothing left to score: the first one not recused, never a recused position 1", () => {
    expect(startIndex([item("p1", "recused", "conflict"), item("p2", "done"), item("p3", "done")], null)).toBe(1);
    // judging closed: pending ones are read-only, so they do not count as needing a score
    expect(startIndex([item("p1", "recused", "conflict"), item("p2", "pending", "Judging is closed")], null)).toBe(1);
  });

  it("positive controls: ?project= still wins, even on a recused project; an all-recused batch opens at 0", () => {
    const items = [item("p1", "done"), item("p2", "recused", "conflict"), item("p3", "pending")];
    expect(startIndex(items, "p2")).toBe(1);
    expect(startIndex(items, "nope")).toBe(2);
    expect(startIndex([item("p1", "recused", "c"), item("p2", "recused", "c")], null)).toBe(0);
    expect(startIndex([], null)).toBe(0);
  });
});
