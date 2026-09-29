import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Follow-up item 3: the server cannot know that this tab paused live updates (the choice lives in
// sessionStorage), yet it drew "Live" with the green dot, so a paused tab showed "Live" on every
// organizer page load and flipped to "Paused" after hydration. The server now draws a neutral
// switch of the same size, and the client fills in the real state.

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));

const { LiveRefresh } = await import("@/components/live-refresh");

function serverMarkup() {
  return renderToString(createElement(LiveRefresh));
}

describe("the live switch's first paint", () => {
  it("claims neither Live nor Paused before the client knows", () => {
    const html = serverMarkup();
    expect(html).not.toContain("bg-ok"); // no green "running" dot
    // both words keep their room (no layout shift) but neither shows
    expect(html).toMatch(/<span class="[^"]*invisible[^"]*">Live<\/span>/);
    expect(html).toMatch(/<span class="[^"]*invisible[^"]*">Paused<\/span>/);
    expect(html).not.toContain("Refreshes every");
    expect(html).not.toContain("Pause live updates");
  });

  it("positive control: the words and the dot are there to be filled in", () => {
    const html = serverMarkup();
    expect(html).toContain(">Live<");
    expect(html).toContain(">Paused<");
    expect(html).toContain("rounded-full");
  });
});
