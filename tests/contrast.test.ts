import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// WCAG 2.2 AA on the design tokens, read straight from globals.css so the check
// and the shipped CSS cannot drift: text pairs need 4.5:1, borders, focus rings
// and markers 3:1. Every token is `light-dark(<light>, <dark>)` or one colour.

type Side = "work" | "public";
type Mode = "light" | "dark";

function tokens(side: Side): Record<Mode, Record<string, string>> {
  const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const block = new RegExp(`\\n\\.${side} \\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no .${side} block in globals.css`);
  const out: Record<Mode, Record<string, string>> = { light: {}, dark: {} };
  for (const m of block[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    const value = m[2].trim();
    const pair = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(value);
    if (pair) {
      out.light[m[1]] = pair[1];
      out.dark[m[1]] = pair[2];
    } else if (/^#[0-9a-f]{6}$/i.test(value)) {
      out.light[m[1]] = value;
      out.dark[m[1]] = value;
    }
  }
  return out;
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT: [string, string][] = [
  ["ink", "bg"],
  ["ink", "surface"],
  ["ink", "raised"],
  ["ink", "accent-tint"],
  ["ink-2", "bg"],
  ["ink-2", "surface"],
  ["ink-2", "raised"],
  ["ink-3", "bg"],
  ["ink-3", "surface"],
  ["ink-3", "sunken"],
  ["ink-3", "raised"],
  ["accent-ink", "surface"],
  ["accent-ink", "bg"],
  ["accent-ink", "accent-tint"],
  ["on-accent", "accent"],
  ["on-primary", "primary"],
  ["flag", "flag-bg"],
  ["flag", "surface"],
  ["ok", "surface"],
  ["teal", "surface"],
];
const NON_TEXT: [string, string][] = [
  ["edge", "surface"],
  ["edge", "bg"],
  ["focus", "surface"],
  ["focus", "bg"],
  ["accent", "surface"],
  ["flag-bar", "surface"],
];

describe("design token contrast (WCAG 2.2 AA)", () => {
  it("the formula reproduces known values, and known-bad pairs fail", () => {
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2); // the classic just-fails grey
    expect(contrast("#777777", "#ffffff")).toBeLessThan(4.5);
    expect(contrast("#6b7a9e", "#0b1020")).toBeLessThan(4.5); // the organizers' muted grey on their navy
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  for (const side of ["work", "public"] as Side[]) {
    for (const mode of ["light", "dark"] as Mode[]) {
      it(`${side} side, ${mode} mode: every text pair >= 4.5 and every non-text pair >= 3`, () => {
        const t = tokens(side)[mode];
        const failures: string[] = [];
        const check = (pairs: [string, string][], min: number) => {
          for (const [fg, bg] of pairs) {
            if (!t[fg] || !t[bg]) {
              failures.push(`missing token ${t[fg] ? bg : fg}`);
              continue;
            }
            const ratio = contrast(t[fg], t[bg]);
            if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
          }
        };
        check(TEXT, 4.5);
        check(NON_TEXT, 3);
        expect(failures).toEqual([]);
      });
    }
  }

  it("known-bad: a token set with a failing pair is caught", () => {
    const t: Record<string, string> = { ...tokens("public").dark, "ink-3": "#6b7a9e" };
    expect(contrast(t["ink-3"], t["bg"])).toBeLessThan(4.5);
  });
});
