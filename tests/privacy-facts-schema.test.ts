import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { KEPT, type KeptFact } from "@/lib/privacy-facts";
import * as schema from "@/server/db/schema";

// The /privacy page says it lists everything the portal stores about the people who use it. So every table with a
// column naming a person (a user id, someone who did something, an email address) must be in the list, plus the
// tables tied to a person through another row: a judge's scores and notes (through the assignment) and a voter's picks.

const PERSON_COLUMN = /(^|_)user_id$|_by$|email/;
const THROUGH_ANOTHER_ROW = ["scores", "score_items", "score_comments", "votes"];

const tables = (Object.values(schema) as unknown[])
  .filter((v): v is SQLiteTable => v instanceof SQLiteTable)
  .map((t) => getTableConfig(t));

function personTables(): string[] {
  const direct = tables.filter((t) => t.columns.some((c) => PERSON_COLUMN.test(c.name))).map((t) => t.name);
  return [...new Set([...direct, ...THROUGH_ANOTHER_ROW])].sort();
}

/** The tables a list names in its Where cells (`table` or `table.column`). */
function listed(kept: KeptFact[]): Set<string> {
  const names = kept.flatMap((f) => f.where.split("`").filter((_, i) => i % 2 === 1).map((code) => code.split(".")[0]!));
  return new Set(names);
}

const missing = (kept: KeptFact[]) => personTables().filter((t) => !listed(kept).has(t));

describe("What we keep names every table that holds something about a person", () => {
  it("finds the person tables in the schema (the scan itself works)", () => {
    const found = personTables();
    for (const t of ["users", "sessions", "team_members", "api_tokens", "password_resets", "account_claims", "audit_log", "outbox"]) {
      expect(found).toContain(t);
    }
    expect(found).not.toContain("tracks");
  });

  it("every one of them is in the list", () => {
    expect(missing(KEPT), "tables holding a person's data that /privacy and DATA-MODEL.md leave out").toEqual([]);
  });

  it("known-bad: dropping a row from the list is caught", () => {
    const withoutTokens = KEPT.filter((f) => !f.where.includes("`api_tokens`"));
    expect(missing(withoutTokens)).toContain("api_tokens");
    expect(missing([])).toEqual(personTables());
  });
});
