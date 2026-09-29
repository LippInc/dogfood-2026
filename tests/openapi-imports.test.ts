import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "@/server/openapi";
import { MAX_QUESTIONS, QUESTION_HELP_MAX, QUESTION_LABEL } from "@/server/project-limits";
import { CRITERION_LABEL, CRITERION_PROMPT_MAX, MAX_CRITERIA } from "@/server/rubric-defaults";

// The API reference's POST /api/imports entry is what a script author reads before sending a file. It lagged the
// importer: it listed only the size limits, said ids another event holds "are renamed" with no word of 409 id_taken,
// and left out the Rubric and Questions tabs' limits the import now keeps. This holds the entry to the importer's own
// refusal codes (read from its source) and to the limits' constants.

const entry = OPERATIONS.find((op) => op.method === "POST" && op.path === "/api/imports")!;
const text = `${entry.summary} ${entry.note ?? ""}`;
const source = ["src/server/db/import-fixtures.ts", "src/server/dal/imports.ts"].map((f) => fs.readFileSync(path.join(process.cwd(), f), "utf8")).join("\n");

describe("the API reference's import entry says what the importer refuses", () => {
  it("names every 409 code the importer throws", () => {
    const codes = [...new Set([...source.matchAll(/new ConflictError\(\s*"(\w+)"/g)].map((m) => m[1]))];
    expect(codes.length).toBeGreaterThanOrEqual(5); // the reader finds the codes (team_full, id_taken, ...)
    expect(codes.filter((c) => !text.includes(c))).toEqual([]);
  });

  it("gives the Rubric and Questions tabs' limits as the code holds them", () => {
    for (const phrase of [
      `${MAX_CRITERIA} criteria`,
      `${CRITERION_LABEL.min} to ${CRITERION_LABEL.max} characters`,
      `prompts of at most ${CRITERION_PROMPT_MAX}`,
      `${MAX_QUESTIONS} questions`,
      `${QUESTION_LABEL.min} to ${QUESTION_LABEL.max} characters`,
      `help of at most ${QUESTION_HELP_MAX}`,
    ]) {
      expect([phrase, text.includes(phrase)]).toEqual([phrase, true]);
    }
  });

  it("says that a review handed out on the portal is never written into", () => {
    expect(text).toMatch(/review the portal handed out[^.]*adds no score/);
  });
});
