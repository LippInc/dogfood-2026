import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The custom scrollbars (globals.css): one style for the page and every inner scroll area, a thumb that
// meets WCAG 1.4.11 (3:1) against the surfaces a scroll area sits on, and never a hidden scrollbar.

const CSS = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\n${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (!m) throw new Error(`no ${selector} block in globals.css`);
  return m[1];
}

function pair(value: string): [string, string] {
  const m = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(value.trim());
  if (!m) throw new Error(`not a light-dark pair: ${value}`);
  return [m[1].toLowerCase(), m[2].toLowerCase()];
}

function prop(body: string, name: string): string | undefined {
  return new RegExp(`(?:^|[;\\s])${name.replace(/-/g, "\\-")}:\\s*([^;]+);`).exec(body)?.[1].trim();
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function sideTokens(side: "work" | "public"): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const m of block(`.${side}`).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const v = m[2].trim();
    if (v.startsWith("light-dark(")) out[m[1]] = pair(v);
    else if (/^#[0-9a-f]{6}$/i.test(v)) out[m[1]] = [v.toLowerCase(), v.toLowerCase()];
  }
  return out;
}

describe("custom scrollbars", () => {
  const root = CSS.split("\n:root {").slice(1).map((b) => b.split("}")[0]).find((b) => b.includes("scrollbar-color")) ?? "";
  const sides = /\n\.work,\n\.public \{([^}]*)\}/.exec(CSS)?.[1] ?? "";

  it("the page (html) and both sides set a thin, token-coloured scrollbar with a transparent track", () => {
    expect(root).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\) transparent;/);
    expect(sides).toMatch(/--scroll-thumb:\s*var\(--edge\);/);
    expect(sides).toMatch(/--scroll-thumb-hover:\s*var\(--ink-3\);/);
    expect(sides).toMatch(/scrollbar-color:\s*var\(--scroll-thumb\) transparent;/);
    expect(CSS).toMatch(/\n\* \{\s*scrollbar-width: thin;\s*\}/);
    expect(CSS).toMatch(/::-webkit-scrollbar-thumb \{[^}]*background: var\(--scroll-thumb\);/);
    expect(CSS).toMatch(/::-webkit-scrollbar-thumb:hover[^{]*\{[^}]*var\(--scroll-thumb-hover\)/);
  });

  it("the page scrollbar outside .work uses the .work edge and ink-3 values exactly", () => {
    const work = sideTokens("work");
    const rootBody = root;
    expect(pair(prop(rootBody, "--scroll-thumb")!)).toEqual(work.edge);
    expect(pair(prop(rootBody, "--scroll-thumb-hover")!)).toEqual(work["ink-3"]);
  });

  for (const side of ["work", "public"] as const) {
    it(`${side}: thumb and hover thumb reach 3:1 on bg and surface, light and dark`, () => {
      const t = sideTokens(side);
      const failures: string[] = [];
      for (const thumb of ["edge", "ink-3"]) {
        for (const under of ["bg", "surface"]) {
          for (const mode of [0, 1]) {
            const ratio = contrast(t[thumb][mode], t[under][mode]);
            if (ratio < 3) failures.push(`${thumb} on ${under} (${mode ? "dark" : "light"}): ${ratio.toFixed(2)}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("known-bad: a pale thumb fails the 3:1 check", () => {
    expect(contrast("#dde1e9", "#f3f4f7")).toBeLessThan(3); // --rule as a thumb would vanish
  });

  it("no stylesheet or component hides a scrollbar", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(css|tsx?)$/.test(e.name)) {
          const src = fs.readFileSync(p, "utf8");
          if (/scrollbar-width:\s*none|scrollbar-none|no-scrollbar|::-webkit-scrollbar\s*\{[^}]*display:\s*none/.test(src)) hits.push(p);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });
});
