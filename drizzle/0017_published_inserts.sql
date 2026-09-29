-- The post-publish freeze for additions (THREAT-MODEL.md, JUDGING.md "The audit trail"): once an event's results
-- are published, the database refuses an INSERT that would add a row to a table the published ranking rests on
-- (scores, score_items, score_comments, assignments, rubric_criteria, judge_overrides, comparisons,
-- normalization_runs, normalized_scores), and the UPDATE and DELETE the first set (0012_triggers) left open on
-- assignments, rubric_criteria and judge_overrides, plus a project's track or duplicate merge. A row the table
-- already holds by one of its unique keys passes, so the boot import's ON CONFLICT DO NOTHING still adds nothing
-- without an error. The text is src/server/db/triggers.ts's, which the boot re-asserts.
CREATE TRIGGER IF NOT EXISTS scores_final_insert
  BEFORE INSERT ON scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM assignments a WHERE a.id = NEW.assignment_id) AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM scores x WHERE x.id = NEW.id OR x.assignment_id = NEW.assignment_id)
  BEGIN
    SELECT RAISE(ABORT, 'scores: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_items_final_insert
  BEFORE INSERT ON score_items
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = NEW.score_id) AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM score_items x WHERE x.score_id = NEW.score_id AND x.criterion_id = NEW.criterion_id)
  BEGIN
    SELECT RAISE(ABORT, 'score_items: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS score_comments_final_insert
  BEFORE INSERT ON score_comments
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT a.event_id FROM scores s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = NEW.score_id) AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM score_comments x WHERE x.score_id = NEW.score_id)
  BEGIN
    SELECT RAISE(ABORT, 'score_comments: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS assignments_final_insert
  BEFORE INSERT ON assignments
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM assignments x WHERE x.id = NEW.id OR (x.judge_user_id = NEW.judge_user_id AND x.project_id = NEW.project_id))
  BEGIN
    SELECT RAISE(ABORT, 'assignments: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS assignments_final_update
  BEFORE UPDATE ON assignments
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'assignments: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS assignments_final_delete
  BEFORE DELETE ON assignments
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'assignments: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS rubric_criteria_final_insert
  BEFORE INSERT ON rubric_criteria
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM rubric_criteria x WHERE x.id = NEW.id OR (x.event_id = NEW.event_id AND x.key = NEW.key))
  BEGIN
    SELECT RAISE(ABORT, 'rubric_criteria: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS rubric_criteria_final_update
  BEFORE UPDATE ON rubric_criteria
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'rubric_criteria: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS rubric_criteria_final_delete
  BEFORE DELETE ON rubric_criteria
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'rubric_criteria: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS judge_overrides_final_insert
  BEFORE INSERT ON judge_overrides
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM judge_overrides x WHERE x.id = NEW.id)
  BEGIN
    SELECT RAISE(ABORT, 'judge_overrides: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS judge_overrides_final_update
  BEFORE UPDATE ON judge_overrides
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'judge_overrides: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS judge_overrides_final_delete
  BEFORE DELETE ON judge_overrides
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'judge_overrides: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS comparisons_final_insert
  BEFORE INSERT ON comparisons
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM comparisons x WHERE x.id = NEW.id)
  BEGIN
    SELECT RAISE(ABORT, 'comparisons: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS normalization_runs_final_insert
  BEFORE INSERT ON normalization_runs
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM normalization_runs x WHERE x.id = NEW.id)
  BEGIN
    SELECT RAISE(ABORT, 'normalization_runs: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS normalized_scores_final_insert
  BEFORE INSERT ON normalized_scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT r.event_id FROM normalization_runs r WHERE r.id = NEW.run_id) AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM normalized_scores x WHERE x.run_id = NEW.run_id AND x.project_id = NEW.project_id)
  BEGIN
    SELECT RAISE(ABORT, 'normalized_scores: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS projects_final_ranking
  BEFORE UPDATE OF track_id, duplicate_of ON projects
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
    AND (NEW.track_id IS NOT OLD.track_id OR NEW.duplicate_of IS NOT OLD.duplicate_of)
  BEGIN
    SELECT RAISE(ABORT, 'projects: the results are published, so the track and merges are final');
  END;
