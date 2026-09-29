import { describe, expect, it } from "vitest";
import { rowTyped } from "@/lib/row-typed";

// The rows editor (src/components/rows-editor.tsx) leaves an untouched new row out of what it
// sends. It used to count only text fields, so a new row changed only in a number (a criterion's
// weight), a select (a question's kind) or a checkbox (a question's "required") was dropped on save
// without a word. These are the settings page's own rows.

const QUESTION = {
  fields: [
    { key: "label", type: "text" },
    { key: "help", type: "text" },
    { key: "type", type: "select" },
    { key: "required", type: "checkbox" },
  ] as const,
  blank: { label: "", help: "", type: "longtext", required: false },
};
const CRITERION = {
  fields: [
    { key: "label", type: "text" },
    { key: "prompt", type: "text" },
    { key: "weight", type: "number" },
  ] as const,
  blank: { label: "", prompt: "", weight: 1 },
};
const typed = (spec: typeof QUESTION | typeof CRITERION, row: Record<string, unknown>) => rowTyped(row, [...spec.fields], spec.blank);

describe("rowTyped", () => {
  it("known-bad: a new row changed only in a checkbox, a select or a number is sent", () => {
    expect(typed(QUESTION, { ...QUESTION.blank, required: true })).toBe(true);
    expect(typed(QUESTION, { ...QUESTION.blank, type: "url" })).toBe(true);
    expect(typed(CRITERION, { ...CRITERION.blank, weight: "2" })).toBe(true);
    expect(typed(CRITERION, { ...CRITERION.blank, weight: "" })).toBe(true); // cleared: sent, so the server names it
  });

  it("controls: the untouched blank row is left out (also with a number typed back to its blank value); text and stored rows are sent", () => {
    expect(typed(QUESTION, { ...QUESTION.blank })).toBe(false);
    expect(typed(CRITERION, { ...CRITERION.blank })).toBe(false);
    expect(typed(CRITERION, { ...CRITERION.blank, weight: "1" })).toBe(false);
    expect(typed(QUESTION, { ...QUESTION.blank, help: "   " })).toBe(false);
    expect(typed(QUESTION, { ...QUESTION.blank, label: "What existed before?" })).toBe(true);
    expect(typed(CRITERION, { id: "crit_1", ...CRITERION.blank })).toBe(true);
  });
});
