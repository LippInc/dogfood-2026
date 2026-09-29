import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { csvCell, personalLinksCsv, toCsv } from "@/lib/csv";

// One escaper for every CSV the portal hands out. The personal-links download is
// built in the browser; before it shared this escaper it had its own quoting with
// no formula guard, so a judge or voter named =HYPERLINK(...) ran as a formula in
// the organizer's spreadsheet.

const bad = ["=HYPERLINK(\"http://x\",\"a\")", "+1+1", "-2+3", "@SUM(A1)", "\tTab", "\rCR", "'quoted"];

describe("shared CSV escaper", () => {
  it("prefixes every formula-leading cell (and an own leading apostrophe) with one apostrophe", () => {
    for (const v of bad) {
      const out = csvCell(v);
      const unquoted = out.startsWith('"') ? out.slice(1, -1).replace(/""/g, '"') : out;
      expect(unquoted).toBe(`'${v}`);
    }
  });

  it("leaves ordinary text, numbers and booleans alone and quotes commas, quotes and line breaks", () => {
    expect(csvCell("Ada Lovelace")).toBe("Ada Lovelace");
    expect(csvCell("a-b")).toBe("a-b");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(null)).toBe("");
    expect(csvCell("Smith, Jo")).toBe('"Smith, Jo"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  it("the personal-links file guards a judge or voter named like a formula", () => {
    const csv = personalLinksCsv(
      [
        { name: '=HYPERLINK("http://evil.test","click")', email: "a@x.test", path: "/claim/abc" },
        { name: "@cmd", email: "+b@x.test", path: "/claim/def" },
        { name: "Plain Name", email: "c@x.test", path: "/claim/ghi" },
      ],
      "http://localhost:8080",
    );
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("name,email,link");
    expect(lines[1]).toBe(`"'=HYPERLINK(""http://evil.test"",""click"")",a@x.test,http://localhost:8080/claim/abc`);
    expect(lines[2]).toBe("'@cmd,'+b@x.test,http://localhost:8080/claim/def");
    expect(lines[3]).toBe("Plain Name,c@x.test,http://localhost:8080/claim/ghi");
    // no line of the file starts a cell with a bare formula character
    for (const line of lines.slice(1)) expect(line).not.toMatch(/(^|,)"?[=+\-@]/);
  });

  it("toCsv is the same function the server exports use", async () => {
    const server = fs.readFileSync(path.join(process.cwd(), "src", "server", "csv.ts"), "utf8");
    expect(server).toMatch(/from "@\/lib\/csv"/);
    expect(toCsv(["a"], [["=1"]])).toBe("a\r\n'=1\r\n");
  });

  it("the browser download no longer carries a quoting function of its own", () => {
    const forms = fs.readFileSync(path.join(process.cwd(), "src", "app", "organize", "[event]", "integrations", "forms.tsx"), "utf8");
    expect(forms).toContain("personalLinksCsv(");
    expect(forms).not.toMatch(/function csvCell/);
  });
});
