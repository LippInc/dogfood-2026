-- The finals (JUDGING.md, "Finals"; DATA-MODEL.md): a round in which a panel of judges scores the finalists.
-- New tables only; the first round's tables are unchanged. The triggers at the end freeze every finals table once
-- the event's results are published, as 0012 and 0017 do for the first round, and keep a finals score on its
-- criterion's scale. Their text is src/server/db/triggers.ts's, which the boot re-asserts.
CREATE TABLE `finalists` (
	`finals_id` text NOT NULL,
	`event_id` text NOT NULL,
	`project_id` text NOT NULL,
	`reason` text,
	`added_at` text NOT NULL,
	`added_by` text NOT NULL,
	PRIMARY KEY(`finals_id`, `project_id`),
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finals_id`,`event_id`) REFERENCES `finals`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`event_id`) REFERENCES `projects`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "finalists_added_iso" CHECK(julianday("finalists"."added_at") is not null)
);
--> statement-breakpoint
CREATE TABLE `finals` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`track_id` text,
	`suggested` integer NOT NULL,
	`opened_at` text NOT NULL,
	`opened_by` text NOT NULL,
	`closed_at` text,
	`closed_by` text,
	`close_reason` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`,`event_id`) REFERENCES `tracks`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "finals_suggested_range" CHECK("finals"."suggested" between 1 and 50),
	CONSTRAINT "finals_opened_iso" CHECK(julianday("finals"."opened_at") is not null),
	CONSTRAINT "finals_closed_iso" CHECK("finals"."closed_at" is null or julianday("finals"."closed_at") is not null),
	CONSTRAINT "finals_closed_by" CHECK(("finals"."closed_at" is null) = ("finals"."closed_by" is null)),
	CONSTRAINT "finals_reason_only_closed" CHECK("finals"."close_reason" is null or "finals"."closed_at" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finals_id_event_uq` ON `finals` (`id`,`event_id`);--> statement-breakpoint
CREATE INDEX `finals_event_idx` ON `finals` (`event_id`);--> statement-breakpoint
CREATE TABLE `finals_panel` (
	`finals_id` text NOT NULL,
	`event_id` text NOT NULL,
	`judge_user_id` text NOT NULL,
	`added_at` text NOT NULL,
	`added_by` text NOT NULL,
	PRIMARY KEY(`finals_id`, `judge_user_id`),
	FOREIGN KEY (`judge_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finals_id`,`event_id`) REFERENCES `finals`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "finals_panel_added_iso" CHECK(julianday("finals_panel"."added_at") is not null)
);
--> statement-breakpoint
CREATE TABLE `finals_score_items` (
	`finals_score_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`value` integer NOT NULL,
	PRIMARY KEY(`finals_score_id`, `criterion_id`),
	FOREIGN KEY (`finals_score_id`) REFERENCES `finals_scores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`criterion_id`) REFERENCES `rubric_criteria`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `finals_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`finals_id` text NOT NULL,
	`event_id` text NOT NULL,
	`project_id` text NOT NULL,
	`judge_user_id` text NOT NULL,
	`saved_at` text NOT NULL,
	FOREIGN KEY (`judge_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finals_id`,`event_id`) REFERENCES `finals`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`event_id`) REFERENCES `projects`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "finals_scores_saved_iso" CHECK(julianday("finals_scores"."saved_at") is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finals_scores_one_uq` ON `finals_scores` (`finals_id`,`project_id`,`judge_user_id`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_final_insert
  BEFORE INSERT ON finals
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM finals x WHERE x.id = NEW.id)
  BEGIN
    SELECT RAISE(ABORT, 'finals: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_final_update
  BEFORE UPDATE ON finals
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_final_delete
  BEFORE DELETE ON finals
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finalists_final_insert
  BEFORE INSERT ON finalists
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM finalists x WHERE x.finals_id = NEW.finals_id AND x.project_id = NEW.project_id)
  BEGIN
    SELECT RAISE(ABORT, 'finalists: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finalists_final_update
  BEFORE UPDATE ON finalists
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finalists: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finalists_final_delete
  BEFORE DELETE ON finalists
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finalists: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_panel_final_insert
  BEFORE INSERT ON finals_panel
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM finals_panel x WHERE x.finals_id = NEW.finals_id AND x.judge_user_id = NEW.judge_user_id)
  BEGIN
    SELECT RAISE(ABORT, 'finals_panel: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_panel_final_update
  BEFORE UPDATE ON finals_panel
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals_panel: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_panel_final_delete
  BEFORE DELETE ON finals_panel
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals_panel: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_scores_final_insert
  BEFORE INSERT ON finals_scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = NEW.event_id AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM finals_scores x WHERE x.id = NEW.id OR (x.finals_id = NEW.finals_id AND x.project_id = NEW.project_id AND x.judge_user_id = NEW.judge_user_id))
  BEGIN
    SELECT RAISE(ABORT, 'finals_scores: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_scores_final_update
  BEFORE UPDATE ON finals_scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals_scores: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_scores_final_delete
  BEFORE DELETE ON finals_scores
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = OLD.event_id AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals_scores: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_score_items_final_insert
  BEFORE INSERT ON finals_score_items
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT f.event_id FROM finals_scores f WHERE f.id = NEW.finals_score_id) AND e.results_published_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM finals_score_items x WHERE x.finals_score_id = NEW.finals_score_id AND x.criterion_id = NEW.criterion_id)
  BEGIN
    SELECT RAISE(ABORT, 'finals_score_items: the results are published, so nothing can be added');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_score_items_final_update
  BEFORE UPDATE ON finals_score_items
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT f.event_id FROM finals_scores f WHERE f.id = OLD.finals_score_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals_score_items: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_score_items_final_delete
  BEFORE DELETE ON finals_score_items
  WHEN EXISTS (SELECT 1 FROM events e WHERE e.id = (SELECT f.event_id FROM finals_scores f WHERE f.id = OLD.finals_score_id) AND e.results_published_at IS NOT NULL)
  BEGIN
    SELECT RAISE(ABORT, 'finals_score_items: the results are published, so this is final');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_score_items_range_insert
  BEFORE INSERT ON finals_score_items
  WHEN NOT EXISTS (
    SELECT 1 FROM rubric_criteria c
    WHERE c.id = NEW.criterion_id AND NEW.value BETWEEN c.scale_min AND c.scale_max
  )
  BEGIN
    SELECT RAISE(ABORT, 'finals_score_items.value is outside its criterion''s scale');
  END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS finals_score_items_range_update
  BEFORE UPDATE OF value, criterion_id ON finals_score_items
  WHEN NOT EXISTS (
    SELECT 1 FROM rubric_criteria c
    WHERE c.id = NEW.criterion_id AND NEW.value BETWEEN c.scale_min AND c.scale_max
  )
  BEGIN
    SELECT RAISE(ABORT, 'finals_score_items.value is outside its criterion''s scale');
  END;
