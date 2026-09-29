import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KEPT, keptTableMarkdown } from "@/lib/privacy-facts";

// The /privacy page and DATA-MODEL.md tell people the same thing: the page renders KEPT, and DATA-MODEL.md's table
// under "What is kept, and for how long" must be exactly keptTableMarkdown(). Change one, change the other.

function tableIn(markdown: string, heading: string): string {
  const at = markdown.indexOf(heading);
  if (at < 0) return "";
  const lines = markdown.slice(at).split("\n");
  const first = lines.findIndex((l) => l.startsWith("|"));
  if (first < 0) return "";
  const rest = lines.slice(first);
  const end = rest.findIndex((l) => !l.startsWith("|"));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

describe("what the portal keeps: one list for the page and DATA-MODEL.md", () => {
  it("DATA-MODEL.md's table is the page's list, row for row", () => {
    const doc = fs.readFileSync(path.join(process.cwd(), "DATA-MODEL.md"), "utf8");
    const table = tableIn(doc, "### What is kept, and for how long");
    expect(table, "DATA-MODEL.md's table differs from src/lib/privacy-facts.ts; the expected table is the right-hand side").toBe(keptTableMarkdown());
  });

  it("known-bad: a row changed in one place only is caught", () => {
    const doc = fs.readFileSync(path.join(process.cwd(), "DATA-MODEL.md"), "utf8");
    const edited = doc.replace("as long as the portal's data", "for 30 days");
    expect(tableIn(edited, "### What is kept, and for how long")).not.toBe(keptTableMarkdown());
    expect(tableIn("no such heading", "### What is kept, and for how long")).not.toBe(keptTableMarkdown());
  });

  it("every row says what, where, how long and what removes it, and no cell breaks the table", () => {
    expect(KEPT.length).toBeGreaterThan(10);
    for (const f of KEPT) {
      for (const cell of [f.what, f.where, f.kept, f.removedBy]) {
        expect(cell.trim().length).toBeGreaterThan(2);
        expect(cell).not.toContain("|");
        expect(cell.split("`").length % 2, `unbalanced backticks in ${cell}`).toBe(1);
      }
    }
  });
});
