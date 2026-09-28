import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DetailRows, DetailToggle } from "@/components/detail-row";

// The results and judges tables opened details inside a cell, which widened its column and slid every column
// beside it sideways (up to 464 px). Details now open in a row of their own, across the table.
describe("details open in a row of their own", () => {
  it("draws the details as a hidden full-width row that the toggle controls", () => {
    const html = renderToStaticMarkup(
      h(
        "table",
        null,
        h("tbody", null, h(DetailRows, { colSpan: 8, detail: "the receipts", children: h("tr", null, h("td", null, h(DetailToggle, { children: "Iron Switch" }))) })),
      ),
    );
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(new RegExp(`<tr id="${controls!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" hidden=""[^>]*><td colSpan="8"`));
    expect(html).toContain("the receipts");
    // nothing opens inside a cell any more
    expect(html).not.toContain("<details");
  });
});
