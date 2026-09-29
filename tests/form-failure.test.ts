import fs from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormFailure } from "@/components/field";

// The note a form shows when its action failed is one component: the same markup and the same role="alert"
// on sign-in, sign-up, the password reset, the account claim, joining a team, accepting a judge invitation and
// entering a vote.

const NOTE = '<p role="alert" class="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">';

describe("FormFailure", () => {
  it("draws the message in the flag note, announced as an alert", () => {
    expect(renderToStaticMarkup(h(FormFailure, { message: "That password is not right." }))).toBe(`${NOTE}That password is not right.</p>`);
  });

  it("draws nothing without a message (positive control for forms that have not failed)", () => {
    expect(renderToStaticMarkup(h(FormFailure, { message: null }))).toBe("");
    expect(renderToStaticMarkup(h(FormFailure, { message: "" }))).toBe("");
  });

  it("known-bad guard: no form under src/app pastes the note's markup again", () => {
    const pasted: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".tsx") && fs.readFileSync(p, "utf8").includes('<p role="alert" className="border-l-[3px] border-flag-bar bg-flag-bg px-3 py-2 text-14 text-flag">')) pasted.push(path.relative(process.cwd(), p));
      }
    };
    walk(path.join(process.cwd(), "src", "app"));
    expect(pasted).toEqual([]);
  });
});
