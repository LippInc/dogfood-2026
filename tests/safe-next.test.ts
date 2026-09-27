import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

// After signing in or up the portal goes to ?next=, which must never leave the site.

describe("safeNext", () => {
  it("keeps a path on this site, with its query and fragment", () => {
    expect(safeNext("/judge/sample-hack-2026")).toBe("/judge/sample-hack-2026");
    expect(safeNext("/events/sample-hack-2026/vote?x=1#ballot")).toBe("/events/sample-hack-2026/vote?x=1#ballot");
  });

  it("known-bad: every way to name another host is refused", () => {
    const slashBack = "/" + String.fromCharCode(92); // a slash, then a backslash
    for (const bad of ["//evil.example", `${slashBack}evil.example`, `${slashBack}/evil.example`, "/\t/evil.example", "/\n/evil.example", "https://evil.example", "javascript:alert(1)", "evil.example", ""]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(safeNext(null)).toBeNull();
  });
});
