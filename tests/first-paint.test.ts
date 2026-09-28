import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// What the server draws is the first paint. Every line that the browser fills in later must already hold its room
// there, or the page moves under the reader after load (the stability check caught 36-38 px drops). No router in a
// unit test: the hooks these components use from next/navigation answer as they would outside a navigation.
vi.mock("next/navigation", () => ({
  usePathname: () => null,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh() {} }),
}));

const { UtcNow } = await import("@/components/utc-now");
const { Deadline } = await import("@/components/deadline");

const paragraphs = (html: string) => [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => m[1]!);

describe("first paint holds the room of what the browser fills in", () => {
  it("draws the UTC line on the server, with placeholder times of the same width", () => {
    const html = renderToStaticMarkup(h(UtcNow));
    expect(html).toContain("These times are UTC");
    expect(html.match(/--:--/g)).toHaveLength(2);
    expect(html).toContain("min-w-[4.5ch]");
  });

  it("gives the deadline's local time and countdown a line each, held by a no-break space", () => {
    const html = renderToStaticMarkup(h(Deadline, { iso: "2030-01-01T18:00:00.000Z", utcLabel: "Tue 1 Jan 2030, 18:00 UTC" }));
    const [label, local, countdown] = paragraphs(html);
    expect(label).toBe("Tue 1 Jan 2030, 18:00 UTC");
    // a plain space collapses to a line of no height; a no-break space keeps one
    expect(local).toBe("\u00a0");
    expect(countdown).toBe("\u00a0");
  });
});
