import { describe, expect, it } from "vitest";
import { startsNavigation } from "@/components/nav-progress";

describe("the loading line starts only for a page load the portal draws", () => {
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  const here = { href: "http://localhost:8080/organize/sample-hack-2026" };
  const link = (href: string, extra: Partial<{ target: string; download: boolean }> = {}) => ({ href, target: "", download: false, ...extra });

  it("starts for another page of the portal, or the same page with other search parameters", () => {
    expect(startsNavigation(click, link("/organize/sample-hack-2026/results"), here)).toBe(true);
    expect(startsNavigation(click, link("http://localhost:8080/judge/sample-hack-2026"), here)).toBe(true);
    expect(startsNavigation(click, link("/organize/sample-hack-2026?track=trk_1"), here)).toBe(true);
  });

  it("does not start for downloads, other sites, new tabs, modifier clicks or the page already open", () => {
    expect(startsNavigation(click, link("/api/events/evt_1/export/normalized.csv"), here)).toBe(false);
    expect(startsNavigation(click, link("/.well-known/dogfood-keys.json"), here)).toBe(false);
    expect(startsNavigation(click, link("https://example.org/"), here)).toBe(false);
    expect(startsNavigation(click, link("/organize", { target: "_blank" }), here)).toBe(false);
    expect(startsNavigation(click, link("/organize", { download: true }), here)).toBe(false);
    expect(startsNavigation({ ...click, metaKey: true }, link("/organize"), here)).toBe(false);
    expect(startsNavigation({ ...click, button: 1 }, link("/organize"), here)).toBe(false);
    expect(startsNavigation(click, link("/organize/sample-hack-2026#decisions-title"), here)).toBe(false);
  });
});
