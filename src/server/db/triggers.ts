import "server-only";
import type Database from "better-sqlite3";

// The one home of every trigger. They are re-asserted at every boot, after the
// migrations: a missing trigger is created, and a trigger whose SQL differs from
// the text below (someone replaced it with a no-op) is dropped and recreated.
// This stops edits made through the app or a stray tool; it cannot stop someone
// who holds the database file and rewrites it by hand. Nor does the hash chain
// in audit_log on its own: it has no key, so that person can recompute it. The
// edit shows only against a head hash kept outside the database: a CSV export,
// a signed record, the public results page (JUDGING.md, "The audit trail").

const range = (event: "INSERT" | "UPDATE OF value, criterion_id") => `
  BEFORE ${event} ON score_items
  WHEN NOT EXISTS (
    SELECT 1 FROM rubric_criteria c
    WHERE c.id = NEW.criterion_id AND NEW.value BETWEEN c.scale_min AND c.scale_max
  )
  BEGIN
    SELECT RAISE(ABORT, 'score_items.value is outside its criterion''s scale');
  END`;

const appendOnly = (table: string, op: "UPDATE" | "DELETE") => `
  BEFORE ${op} ON ${table}
  BEGIN
    SELECT RAISE(ABORT, '${table} is append-only: ${op} rejected');
  END`;

// Once an event's results are published its numbers are final: the app refuses every
// change, and these make the database refuse an edit or a removal too. INSERT is left to
// the app on purpose: the boot import inserts with ON CONFLICT DO NOTHING, which fires
// BEFORE INSERT triggers even for rows it then skips, and a published run cannot move
// with new rows anyway, since runs are append-only.
const eventOfScore = (scoreId: string) => `(SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ${scoreId})`;
const eventOfAssignment = (assignmentId: string) => `(SELECT a.event_id FROM assignments a WHERE a.id = ${assignmentId})`;
const final = (table: string, op: "UPDATE" | "DELETE", eventId: string) => `
  BEFORE ${op} ON ${table}
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = ${eventId} AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, '${table}: the results are published, so this is final');
  END`;

export const TRIGGERS: Record<string, string> = {
  normalization_runs_no_update: appendOnly("normalization_runs", "UPDATE"),
  normalization_runs_no_delete: appendOnly("normalization_runs", "DELETE"),
  normalized_scores_no_update: appendOnly("normalized_scores", "UPDATE"),
  normalized_scores_no_delete: appendOnly("normalized_scores", "DELETE"),
  score_items_final_update: final("score_items", "UPDATE", eventOfScore("OLD.score_id")),
  score_items_final_delete: final("score_items", "DELETE", eventOfScore("OLD.score_id")),
  score_comments_final_update: final("score_comments", "UPDATE", eventOfScore("OLD.score_id")),
  score_comments_final_delete: final("score_comments", "DELETE", eventOfScore("OLD.score_id")),
  scores_final_update: final("scores", "UPDATE", eventOfAssignment("OLD.assignment_id")),
  scores_final_delete: final("scores", "DELETE", eventOfAssignment("OLD.assignment_id")),
  comparisons_final_update: final("comparisons", "UPDATE", "OLD.event_id"),
  comparisons_final_delete: final("comparisons", "DELETE", "OLD.event_id"),
  // published results cannot be withdrawn, re-dated or pointed at another run
  events_published_final: `
  BEFORE UPDATE OF results_published_at, settings ON events
  WHEN OLD.results_published_at IS NOT NULL
    AND (NEW.results_published_at IS NOT OLD.results_published_at
      OR json_extract(NEW.settings, '$.publishedRunId') IS NOT json_extract(OLD.settings, '$.publishedRunId'))
  BEGIN
    SELECT RAISE(ABORT, 'events: published results cannot be withdrawn or swapped');
  END`,
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
