import { describe, expect, it } from "vitest";
import { ask } from "@/lib/help";
import { CORPUS, READERS, type Reader, type Want } from "./help-corpus-table";

/** Each row's wrong first answers, as "reader: question -> got (want)"; empty when the whole corpus passes. */
export function corpusFailures(askFn: typeof ask = ask): string[] {
  const out: string[] = [];
  for (const [q, spec] of CORPUS)
    for (const reader of Object.keys(READERS) as Reader[]) {
      const want: Want = spec !== null && typeof spec === "object" && !Array.isArray(spec) ? (spec[reader] !== undefined ? spec[reader]! : spec.all) : spec;
      const ok = Array.isArray(want) ? want : [want];
      const got = askFn(q, READERS[reader]).matches[0]?.entry.id ?? null;
      if (!ok.includes(got)) out.push(`${reader}: ${q} -> ${got ?? "no match"} (want ${ok.map((w) => w ?? "no match").join(" or ")})`);
    }
  return out;
}

describe("the Help corpus: every question, every reader", () => {
  it("is large enough and asks each question once", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(200);
    const qs = CORPUS.map(([q]) => q);
    expect(qs.filter((q, i) => qs.indexOf(q) !== i)).toEqual([]);
  });

  it("gives each reader the expected first entry, or no match where the portal has no answer", () => {
    expect(corpusFailures()).toEqual([]);
  });

  it("fails a known-bad matcher (the instrument can go red)", () => {
    const wrong: typeof ask = (q, v) => ({ ...ask(q, v), matches: [] });
    expect(corpusFailures(wrong).length).toBeGreaterThan(100);
  });
});
