import "server-only";
import type Database from "better-sqlite3";

// The one place to change a trigger. The migrations make them too, with the same
// text (drizzle/0012_triggers.sql), so a database built from drizzle/ alone is
// guarded; tests/triggers-migration.test.ts fails while the two disagree, so a
// change here needs a migration that drops and recreates it. They are also
// re-asserted at every boot, after the migrations: a missing trigger is created,
// and a trigger whose SQL differs from the text below (someone replaced it with
// a no-op) is dropped and recreated.
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
// change, and these make the database refuse an edit, a removal or an addition too, on every
// table the ranking rests on (reviews with their values and feedback, assignments, the
// rubric's criteria and weights, the organizers' judge overrides, pairwise answers, the
// stored runs, and a project's track or merge). An INSERT is refused only when it would add
// a row: the boot import inserts with ON CONFLICT DO NOTHING, which fires BEFORE INSERT
// triggers even for rows it then skips, so a row the table already holds (by any of its
// unique keys) passes and the import adds nothing, as before. What the app allows after
// publishing (records, certificates, the audit log, sessions, the outbox, webhooks,
// comments) writes none of these tables.
const eventOfScore = (scoreId: string) => `(SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ${scoreId})`;
const eventOfAssignment = (assignmentId: string) => `(SELECT a.event_id FROM assignments a WHERE a.id = ${assignmentId})`;
const final = (table: string, op: "UPDATE" | "DELETE", eventId: string) => `
  BEFORE ${op} ON ${table}
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = ${eventId} AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, '${table}: the results are published, so this is final');
  END`;

const published = (eventId: string) => `EXISTS (SELECT 1 FROM events e WHERE e.id = ${eventId} AND e.results_published_at IS NOT NULL)`;
const frozenInsert = (table: string, eventId: string, already: string) => `
  BEFORE INSERT ON ${table}
  WHEN ${published(eventId)}
    AND NOT EXISTS (SELECT 1 FROM ${table} x WHERE ${already})
  BEGIN
    SELECT RAISE(ABORT, '${table}: the results are published, so nothing can be added');
  END`;
const eventOfRun = (runId: string) => `(SELECT r.event_id FROM normalization_runs r WHERE r.id = ${runId})`;

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
  // the additions, and the tables the first set left open (drizzle/0017_published_inserts.sql)
  scores_final_insert: frozenInsert("scores", eventOfAssignment("NEW.assignment_id"), "x.id = NEW.id OR x.assignment_id = NEW.assignment_id"),
  score_items_final_insert: frozenInsert("score_items", eventOfScore("NEW.score_id"), "x.score_id = NEW.score_id AND x.criterion_id = NEW.criterion_id"),
  score_comments_final_insert: frozenInsert("score_comments", eventOfScore("NEW.score_id"), "x.score_id = NEW.score_id"),
  assignments_final_insert: frozenInsert("assignments", "NEW.event_id", "x.id = NEW.id OR (x.judge_user_id = NEW.judge_user_id AND x.project_id = NEW.project_id)"),
  assignments_final_update: final("assignments", "UPDATE", "OLD.event_id"),
  assignments_final_delete: final("assignments", "DELETE", "OLD.event_id"),
  rubric_criteria_final_insert: frozenInsert("rubric_criteria", "NEW.event_id", "x.id = NEW.id OR (x.event_id = NEW.event_id AND x.key = NEW.key)"),
  rubric_criteria_final_update: final("rubric_criteria", "UPDATE", "OLD.event_id"),
  rubric_criteria_final_delete: final("rubric_criteria", "DELETE", "OLD.event_id"),
  judge_overrides_final_insert: frozenInsert("judge_overrides", "NEW.event_id", "x.id = NEW.id"),
  judge_overrides_final_update: final("judge_overrides", "UPDATE", "OLD.event_id"),
  judge_overrides_final_delete: final("judge_overrides", "DELETE", "OLD.event_id"),
  comparisons_final_insert: frozenInsert("comparisons", "NEW.event_id", "x.id = NEW.id"),
  normalization_runs_final_insert: frozenInsert("normalization_runs", "NEW.event_id", "x.id = NEW.id"),
  normalized_scores_final_insert: frozenInsert("normalized_scores", eventOfRun("NEW.run_id"), "x.run_id = NEW.run_id AND x.project_id = NEW.project_id"),
  // the two decisions that move a project in the ranking: its track and a duplicate merge
  projects_final_ranking: `
  BEFORE UPDATE OF track_id, duplicate_of ON projects
  WHEN ${published("OLD.event_id")}
    AND (NEW.track_id IS NOT OLD.track_id OR NEW.duplicate_of IS NOT OLD.duplicate_of)
  BEGIN
    SELECT RAISE(ABORT, 'projects: the results are published, so the track and merges are final');
  END`,
};

/**
 * Whether an error is one of the post-publish refusals above. An import into a published event counts what it
 * added and refuses in its own words; a row that would add a review, a criterion or an assignment now stops at the
 * trigger first, so the callers (dal/imports.ts, the boot's bootFixture) map this to the same refusal.
 */
export function isPublishedRefusal(err: unknown): boolean {
  return err instanceof Error && /: the results are published, so /.test(err.message);
}

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
