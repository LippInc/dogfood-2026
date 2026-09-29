import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { dropLaterTriggers } from "./support/old-portal";

// 0015 rebuilds the outbox to widen its status CHECK (sending, unknown). A portal that already mailed keeps
// every row through it, the index comes back, and the table's other rules still hold.

describe("migration 0015 on a portal that already mailed", () => {
  it("keeps the rows, accepts the new statuses and still refuses what it refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outbox-mig-"));
    try {
      const src = path.join(process.cwd(), "drizzle");
      const full = JSON.parse(fs.readFileSync(path.join(src, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
      const journal = { ...full, entries: full.entries.filter((e) => e.idx <= 14) };
      expect(journal.entries.at(-1)!.tag).toBe("0014_audit_salt");
      fs.mkdirSync(path.join(dir, "meta"));
      fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(journal));
      for (const e of journal.entries) fs.copyFileSync(path.join(src, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));

      const h = openDatabase(":memory:");
      try {
        runMigrations(h, dir);
        dropLaterTriggers(h.sqlite, 14);
        const insert = h.sqlite.prepare(
          "INSERT INTO outbox (id, event_id, kind, to_email, subject, body, status, error, created_by, created_at, sent_at) VALUES (?, NULL, 'password_reset', 'a@example.org', 'Set a new password', 'body', ?, ?, NULL, '2026-09-28T00:00:00.000Z', ?)",
        );
        insert.run("mail_old_sent", "sent", null, "2026-09-28T00:00:01.000Z");
        insert.run("mail_old_failed", "failed", "connection refused", null);
        expect(() => insert.run("mail_old_unknown", "unknown", "Timeout", null)).toThrow(/constraint/i); // the old CHECK

        runMigrations(h, src); // the rest, 0015 included
        const rows = h.sqlite.prepare("SELECT id, status, error, sent_at AS sentAt FROM outbox ORDER BY id").all();
        expect(rows).toEqual([
          { id: "mail_old_failed", status: "failed", error: "connection refused", sentAt: null },
          { id: "mail_old_sent", status: "sent", error: null, sentAt: "2026-09-28T00:00:01.000Z" },
        ]);
        insert.run("mail_new_unknown", "unknown", "Timeout", null);
        insert.run("mail_new_sending", "sending", null, null);
        expect(() => insert.run("mail_bad", "queued", null, null)).toThrow(/constraint/i);
        expect(() => insert.run("mail_bad2", "sending", null, "2026-09-28T00:00:01.000Z")).toThrow(/constraint/i); // a stamp only on a sent row
        const sql = (h.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'outbox'").get() as { sql: string }).sql;
        expect(sql).not.toContain("__new_outbox");
        expect(h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'outbox_event_idx'").get()).toBeTruthy();
      } finally {
        h.sqlite.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
