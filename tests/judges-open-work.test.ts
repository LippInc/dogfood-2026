import { describe, expect, it } from "vitest";
import { openWork } from "@/lib/judge-open-work";

// The organizer's Judges table after results are published: a judge who left reviews unfinished
// is no longer someone to remind, because scoring is over (their console says scores are final).

describe("the Judges table's word for unfinished reviews", () => {
  it("after publication: says results are published and offers no reminder", () => {
    const w = openWork(2, true);
    expect(w.remind).toBe(false);
    expect(w.label).toBe("2 unfinished");
    expect(w.note).toBe("Results are published, so scoring is over.");
    expect(w.group).toBe("Unfinished");
  });

  it("positive control: while judging runs the reviews are open and the reminder is offered", () => {
    const w = openWork(3, false);
    expect(w.remind).toBe(true);
    expect(w.label).toBe("3 open");
    expect(w.note).toBeNull();
    expect(w.group).toBe("Open reviews");
  });
});
