-- Every trigger, made by the migrations as well, so a database built from drizzle/ alone is guarded.
-- The text is src/server/db/triggers.ts's, the place to change one (then add a migration that drops
-- and recreates it). The boot re-asserts that file's text and restores a trigger whose SQL was
-- replaced; tests/triggers-migration.test.ts fails while the migrations and that file disagree.
CREATE TRIGGER IF NOT EXISTS normalization_runs_no_update
  BEFORE UPDATE ON normalization_runs
  BEGIN
    SELECT RAISE(ABORT, 'normalization_runs is append-only: UPDATE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS normalization_runs_no_delete
  BEFORE DELETE ON normalization_runs
  BEGIN
    SELECT RAISE(ABORT, 'normalization_runs is append-only: DELETE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS normalized_scores_no_update
  BEFORE UPDATE ON normalized_scores
  BEGIN
    SELECT RAISE(ABORT, 'normalized_scores is append-only: UPDATE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS normalized_scores_no_delete
  BEFORE DELETE ON normalized_scores
  BEGIN
    SELECT RAISE(ABORT, 'normalized_scores is append-only: DELETE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_items_final_update
  BEFORE UPDATE ON score_items
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = OLD.score_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'score_items: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_items_final_delete
  BEFORE DELETE ON score_items
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = OLD.score_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'score_items: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_comments_final_update
  BEFORE UPDATE ON score_comments
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = OLD.score_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'score_comments: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_comments_final_delete
  BEFORE DELETE ON score_comments
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = OLD.score_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'score_comments: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS scores_final_update
  BEFORE UPDATE ON scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM assignments a WHERE a.id = OLD.assignment_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'scores: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS scores_final_delete
  BEFORE DELETE ON scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM assignments a WHERE a.id = OLD.assignment_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'scores: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS comparisons_final_update
  BEFORE UPDATE ON comparisons
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'comparisons: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS comparisons_final_delete
  BEFORE DELETE ON comparisons
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'comparisons: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS events_published_final
  BEFORE UPDATE OF results_published_at, settings ON events
  WHEN OLD.results_published_at IS NOT NULL
    AND (NEW.results_published_at IS NOT OLD.results_published_at
      OR json_extract(NEW.settings, '$.publishedRunId') IS NOT json_extract(OLD.settings, '$.publishedRunId'))
  BEGIN
    SELECT RAISE(ABORT, 'events: published results cannot be withdrawn or swapped');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: DELETE rejected');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_items_range_insert
  BEFORE INSERT ON score_items
  WHEN NOT EXISTS (
    SELECT 1 FROM rubric_criteria c
    WHERE c.id = NEW.criterion_id AND NEW.value BETWEEN c.scale_min AND c.scale_max
  )
  BEGIN
    SELECT RAISE(ABORT, 'score_items.value is outside its criterion''s scale');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_items_range_update
  BEFORE UPDATE OF value, criterion_id ON score_items
  WHEN NOT EXISTS (
    SELECT 1 FROM rubric_criteria c
    WHERE c.id = NEW.criterion_id AND NEW.value BETWEEN c.scale_min AND c.scale_max
  )
  BEGIN
    SELECT RAISE(ABORT, 'score_items.value is outside its criterion''s scale');
  END;
