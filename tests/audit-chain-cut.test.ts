import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anchorHolds, appendAudit, chainHead, verifyAuditChain } from "@/server/audit";
import { openDatabase, type Handle } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { importFixtures, loadFixtureFile } from "@/server/db/import-fixtures";
import { auditCsv } from "@/server/dal/audit-log";
import { chainBrokenText, chainHeading } from "@/components/audit-chain";

// Rows cut off the end of the audit log leave what remains a whole chain. The check reads SQLite's own count of the
// rows it gave ids (sqlite_sequence) and reports a cut when that count is past the last row (src/server/audit.ts).
// A tripwire for a careless cut only: whoever also lowers that count is caught by a head kept outside, such as
// audit.csv's chain_head and chain_head_entry, the pair a signed record pins. Rows are cut here as someone holding the
// file would: the delete trigger dropped first.

const AT = "2026-09-29T08:00:00.000Z";
let h: Handle;

beforeEach(() => {
  h = openDatabase(":memory:");
  runMigrations(h, path.join(process.cwd(), "drizzle"));
  const { fixture, sha256 } = loadFixtureFile(path.join(process.cwd(), "fixtures.json"));
  importFixtures(h.db, fixture, { source: "fixtures.json", sha256, now: AT });
  for (let i = 1; i <= 5; i++) appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: `test.row_${i}`, eventId: "evt_01" }, AT);
});

afterEach(() => {
  h.sqlite.close();
});

const lastId = () => (h.sqlite.prepare("SELECT max(id) AS id FROM audit_log").get() as { id: number }).id;
const cutLast = (n: number) => {
  h.sqlite.exec("DROP TRIGGER audit_log_no_delete");
  h.sqlite.prepare("DELETE FROM audit_log WHERE id > ?").run(lastId() - n);
};
/** audit.csv as rows of cells (RFC 4180: quoted cells, doubled quotes, CRLF or LF). */
function csvLines(): string[][] {
  const text = auditCsv(h.db, "evt_01");
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) out.push([...row, cell]);
  return out;
}

describe("rows cut off the end of the audit log", () => {
  it("positive control: the log as the app writes it verifies, also after a transaction that wrote rows and rolled back", () => {
    const before = verifyAuditChain(h.db);
    expect(before.ok).toBe(true);
    expect(() =>
      h.db.transaction((tx) => {
        appendAudit(tx, { actorUserId: null, actorLabel: "system", action: "test.rolled_back" }, AT);
        appendAudit(tx, { actorUserId: null, actorLabel: "system", action: "test.rolled_back" }, AT);
        throw new Error("refused");
      }),
    ).toThrow("refused");
    expect(verifyAuditChain(h.db)).toEqual(before); // the rolled-back ids are given back, so no cut is seen
    appendAudit(h.db, { actorUserId: null, actorLabel: "system", action: "test.after" }, AT);
    expect(verifyAuditChain(h.db)).toMatchObject({ ok: true, rows: (before as { rows: number }).rows + 1 });
  });

  it("known-bad: three rows cut from the end are reported, with the first missing row", () => {
    const last = lastId();
    cutLast(3);
    expect(verifyAuditChain(h.db)).toEqual({ ok: false, rows: last - 3, brokenAtId: last - 2, cut: 3 });
  });

  it("known-bad: a log emptied whole is reported, not verified as an empty chain", () => {
    const last = lastId();
    h.sqlite.exec("DROP TRIGGER audit_log_no_delete");
    h.sqlite.exec("DELETE FROM audit_log");
    expect(verifyAuditChain(h.db)).toEqual({ ok: false, rows: 0, brokenAtId: 1, cut: last });
  });

  it("the limit: a cut that also lowers SQLite's count passes the check, and only a head kept outside shows it", () => {
    const kept = chainHead(h.db)!; // e.g. from an earlier audit.csv or a signed record
    cutLast(2);
    h.sqlite.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'audit_log'").run(lastId());
    expect(verifyAuditChain(h.db).ok).toBe(true);
    expect(anchorHolds(h.db, kept)).toBe(false);
  });

  it("audit.csv carries the head's hash and entry on every line, and says so when rows were cut", () => {
    const head = chainHead(h.db)!;
    const [header, ...rows] = csvLines();
    expect(header!.slice(-3)).toEqual(["chain_ok", "chain_head", "chain_head_entry"]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.slice(-3)).toEqual(["yes", head.hash, String(head.entry)]);

    cutLast(2);
    const [, ...after] = csvLines();
    expect(after.at(-1)!.slice(-3)).toEqual(["no", `2 cut from the end, after entry ${head.entry - 2}`, ""]);
  });

  it("the seal says what happened, in words", () => {
    expect(chainHeading({ ok: false, brokenAtId: 41, cut: 3 })).toBe("3 rows cut from the end");
    expect(chainBrokenText({ ok: false, brokenAtId: 41, cut: 3 })).toBe(
      "The log ends at row #40, but SQLite's own count says 43 rows were written: the last 3 were removed outside the app. Treat the log as unverified.",
    );
    expect(chainBrokenText({ ok: false, brokenAtId: 1, cut: 1 })).toBe(
      "The log is empty, but SQLite's own count says 1 row was written: the last one was removed outside the app. Treat the log as unverified.",
    );
    expect(chainHeading({ ok: false, brokenAtId: 7 })).toBe("Chain broken at row #7");
    expect(chainBrokenText({ ok: false, brokenAtId: 7 })).toBe("A row was changed outside the app. Treat everything from row #7 on as unverified.");
  });
});
