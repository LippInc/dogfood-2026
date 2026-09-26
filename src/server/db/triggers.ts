import "server-only";
import type Database from "better-sqlite3";

// The one home of every trigger. They are re-asserted at every boot, after the
// migrations: a missing trigger is created, and a trigger whose SQL differs from
// the text below (someone replaced it with a no-op) is dropped and recreated.
// This stops edits made through the app or a stray tool; it cannot stop someone
// who holds the database file and rewrites it by hand. The hash chain in
// audit_log is what makes such an edit visible (JUDGING.md, "Audit trail").

const range = (event: "INSERT" | "UPDATE OF value, criterion_id") => `
  BEFORE ${event} ON score_items
  WHEN NOT EXISTS (
    SELECT 1 FROM rubric_criteria c
    WHERE c.id = NEW.criterion_id AND NEW.value BETWEEN c.scale_min AND c.scale_max
  )
  BEGIN
    SELECT RAISE(ABORT, 'score_items.value is outside its criterion''s scale');
  END`;

export const TRIGGERS: Record<string, string> = {
  audit_log_no_update: `
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE rejected');
  END`,
  audit_log_no_delete: `
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: DELETE rejected');
  END`,
  score_items_range_insert: range("INSERT"),
  score_items_range_update: range("UPDATE OF value, criterion_id"),
};

const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export type TriggerReport = { created: string[]; restored: string[] };

export function assertTriggers(sqlite: Database.Database): TriggerReport {
  const report: TriggerReport = { created: [], restored: [] };
  const existing = new Map(
    (sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as {
      name: string;
      sql: string;
    }[]).map((r) => [r.name, r.sql]),
  );
  sqlite.transaction(() => {
    for (const [name, body] of Object.entries(TRIGGERS)) {
      const wanted = `CREATE TRIGGER ${name}${body}`;
      const found = existing.get(name);
      if (found === undefined) {
        sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${name}${body}`);
        report.created.push(name);
      } else if (normalize(found) !== normalize(wanted) && normalize(found) !== normalize(`CREATE TRIGGER IF NOT EXISTS ${name}${body}`)) {
        sqlite.exec(`DROP TRIGGER ${name}`);
        sqlite.exec(`CREATE TRIGGER IF NOT EXISTS ${name}${body}`);
        report.restored.push(name);
      }
    }
  })();
  return report;
}
