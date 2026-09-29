-- CHECK constraints and foreign keys the tables lacked (DATA-MODEL.md): the ISO-timestamp CHECK on every
-- timestamp column of these tables, "who did it" set exactly when "when" is (judge_overrides.revoked_by,
-- voters.voided_by, comments.hidden_by, judge_invites.accepted_by), normalization_runs.method limited to the
-- two engines, and foreign keys from webhook_deliveries.audit_id to audit_log and from judge_invites.created_by
-- to users. A reference to audit_log never writes to it, so its append-only triggers are untouched.
--
-- SQLite cannot add a CHECK or a foreign key to a table that exists, so each table is rebuilt the way SQLite's
-- documentation gives (https://sqlite.org/lang_altertable.html#otheralter): make the new table, copy every row,
-- drop the old one, rename, and make its indexes again. The copy goes through the new constraints, so a database
-- holding a row that breaks one refuses the whole migration and keeps its old schema; the app has only ever
-- written rows these constraints accept. src/server/db/migrate.ts turns foreign-key enforcement off around the
-- migrator (a PRAGMA inside the migrator's transaction does nothing) and runs PRAGMA foreign_key_check after it.
--
-- The triggers on these tables, and those whose body reads events or scores, are dropped first (a rename checks
-- every trigger's body, and one naming a table that is gone for the moment fails it) and made again at the end
-- with src/server/db/triggers.ts's text, as 0012_triggers made them. audit_log is not rebuilt: its triggers stay.
DROP TRIGGER IF EXISTS normalization_runs_no_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS normalization_runs_no_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS score_items_final_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS score_items_final_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS score_comments_final_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS score_comments_final_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_final_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS scores_final_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS comparisons_final_update;
--> statement-breakpoint
DROP TRIGGER IF EXISTS comparisons_final_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS events_published_final;
--> statement-breakpoint
CREATE TABLE `__new_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`last_used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_tokens_name" CHECK(length(trim("__new_api_tokens"."name")) between 1 and 60),
	CONSTRAINT "api_tokens_expiry" CHECK("__new_api_tokens"."expires_at" is null or julianday("__new_api_tokens"."expires_at") > julianday("__new_api_tokens"."created_at")),
	CONSTRAINT "api_tokens_created_iso" CHECK(julianday("__new_api_tokens"."created_at") is not null),
	CONSTRAINT "api_tokens_expires_iso" CHECK("__new_api_tokens"."expires_at" is null or julianday("__new_api_tokens"."expires_at") is not null),
	CONSTRAINT "api_tokens_last_used_iso" CHECK("__new_api_tokens"."last_used_at" is null or julianday("__new_api_tokens"."last_used_at") is not null),
	CONSTRAINT "api_tokens_revoked_iso" CHECK("__new_api_tokens"."revoked_at" is null or julianday("__new_api_tokens"."revoked_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_api_tokens`("id", "user_id", "name", "token_hash", "hint", "created_at", "expires_at", "last_used_at", "revoked_at") SELECT "id", "user_id", "name", "token_hash", "hint", "created_at", "expires_at", "last_used_at", "revoked_at" FROM `api_tokens`;--> statement-breakpoint
DROP TABLE `api_tokens`;--> statement-breakpoint
ALTER TABLE `__new_api_tokens` RENAME TO `api_tokens`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`hidden_at` text,
	`hidden_by` text,
	`hidden_reason` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comments_body_length" CHECK(length(trim("__new_comments"."body")) between 1 and 2000),
	CONSTRAINT "comments_hidden_reason" CHECK("__new_comments"."hidden_at" is null or length(trim(coalesce("__new_comments"."hidden_reason", ''))) >= 3),
	CONSTRAINT "comments_hidden_by" CHECK(("__new_comments"."hidden_at" is null) = ("__new_comments"."hidden_by" is null)),
	CONSTRAINT "comments_created_iso" CHECK(julianday("__new_comments"."created_at") is not null),
	CONSTRAINT "comments_hidden_iso" CHECK("__new_comments"."hidden_at" is null or julianday("__new_comments"."hidden_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_comments`("id", "event_id", "project_id", "user_id", "body", "created_at", "hidden_at", "hidden_by", "hidden_reason") SELECT "id", "event_id", "project_id", "user_id", "body", "created_at", "hidden_at", "hidden_by", "hidden_reason" FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
CREATE INDEX `comments_project_idx` ON `comments` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`submissions_open_at` text,
	`submissions_close_at` text NOT NULL,
	`judging_close_at` text,
	`voting_open_at` text,
	`voting_close_at` text,
	`results_published_at` text,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "events_slug_format" CHECK("__new_events"."slug" glob '[a-z0-9]*' and "__new_events"."slug" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "events_close_iso" CHECK(julianday("__new_events"."submissions_close_at") is not null),
	CONSTRAINT "events_open_iso" CHECK("__new_events"."submissions_open_at" is null or julianday("__new_events"."submissions_open_at") is not null),
	CONSTRAINT "events_judging_close_iso" CHECK("__new_events"."judging_close_at" is null or julianday("__new_events"."judging_close_at") is not null),
	CONSTRAINT "events_voting_open_iso" CHECK("__new_events"."voting_open_at" is null or julianday("__new_events"."voting_open_at") is not null),
	CONSTRAINT "events_voting_close_iso" CHECK("__new_events"."voting_close_at" is null or julianday("__new_events"."voting_close_at") is not null),
	CONSTRAINT "events_published_iso" CHECK("__new_events"."results_published_at" is null or julianday("__new_events"."results_published_at") is not null),
	CONSTRAINT "events_created_iso" CHECK(julianday("__new_events"."created_at") is not null),
	CONSTRAINT "events_window_order" CHECK("__new_events"."submissions_open_at" is null or julianday("__new_events"."submissions_open_at") < julianday("__new_events"."submissions_close_at")),
	CONSTRAINT "events_voting_order" CHECK("__new_events"."voting_open_at" is null or "__new_events"."voting_close_at" is null or julianday("__new_events"."voting_open_at") < julianday("__new_events"."voting_close_at")),
	CONSTRAINT "events_settings_json" CHECK(json_valid("__new_events"."settings"))
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "slug", "name", "description", "submissions_open_at", "submissions_close_at", "judging_close_at", "voting_open_at", "voting_close_at", "results_published_at", "settings", "created_at") SELECT "id", "slug", "name", "description", "submissions_open_at", "submissions_close_at", "judging_close_at", "voting_open_at", "voting_close_at", "results_published_at", "settings", "created_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_judge_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text,
	`track_ids` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`accepted_at` text,
	`accepted_by` text,
	`revoked_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_invites_tracks_json" CHECK(json_valid("__new_judge_invites"."track_ids") and json_type("__new_judge_invites"."track_ids") = 'array'),
	CONSTRAINT "judge_invites_email_lower" CHECK("__new_judge_invites"."email" is null or "__new_judge_invites"."email" = lower("__new_judge_invites"."email")),
	CONSTRAINT "judge_invites_one_outcome" CHECK("__new_judge_invites"."accepted_at" is null or "__new_judge_invites"."revoked_at" is null),
	CONSTRAINT "judge_invites_accepted_by" CHECK(("__new_judge_invites"."accepted_at" is null) = ("__new_judge_invites"."accepted_by" is null)),
	CONSTRAINT "judge_invites_created_iso" CHECK(julianday("__new_judge_invites"."created_at") is not null),
	CONSTRAINT "judge_invites_accepted_iso" CHECK("__new_judge_invites"."accepted_at" is null or julianday("__new_judge_invites"."accepted_at") is not null),
	CONSTRAINT "judge_invites_revoked_iso" CHECK("__new_judge_invites"."revoked_at" is null or julianday("__new_judge_invites"."revoked_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_judge_invites`("id", "event_id", "code_hash", "name", "email", "track_ids", "created_at", "created_by", "accepted_at", "accepted_by", "revoked_at") SELECT "id", "event_id", "code_hash", "name", "email", "track_ids", "created_at", "created_by", "accepted_at", "accepted_by", "revoked_at" FROM `judge_invites`;--> statement-breakpoint
DROP TABLE `judge_invites`;--> statement-breakpoint
ALTER TABLE `__new_judge_invites` RENAME TO `judge_invites`;--> statement-breakpoint
CREATE UNIQUE INDEX `judge_invites_code_hash_unique` ON `judge_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `judge_invites_event_idx` ON `judge_invites` (`event_id`);--> statement-breakpoint
CREATE TABLE `__new_judge_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`judge_user_id` text NOT NULL,
	`mode` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`judge_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_overrides_mode_check" CHECK("__new_judge_overrides"."mode" in ('include', 'exclude')),
	CONSTRAINT "judge_overrides_reason_nonempty" CHECK(length(trim("__new_judge_overrides"."reason")) >= 3),
	CONSTRAINT "judge_overrides_revoked_by" CHECK(("__new_judge_overrides"."revoked_at" is null) = ("__new_judge_overrides"."revoked_by" is null)),
	CONSTRAINT "judge_overrides_created_iso" CHECK(julianday("__new_judge_overrides"."created_at") is not null),
	CONSTRAINT "judge_overrides_revoked_iso" CHECK("__new_judge_overrides"."revoked_at" is null or julianday("__new_judge_overrides"."revoked_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_judge_overrides`("id", "event_id", "judge_user_id", "mode", "reason", "created_at", "created_by", "revoked_at", "revoked_by") SELECT "id", "event_id", "judge_user_id", "mode", "reason", "created_at", "created_by", "revoked_at", "revoked_by" FROM `judge_overrides`;--> statement-breakpoint
DROP TABLE `judge_overrides`;--> statement-breakpoint
ALTER TABLE `__new_judge_overrides` RENAME TO `judge_overrides`;--> statement-breakpoint
CREATE TABLE `__new_normalization_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`method` text NOT NULL,
	`params` text NOT NULL,
	`computed_at` text NOT NULL,
	`computed_by` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "normalization_runs_params_json" CHECK(json_valid("__new_normalization_runs"."params")),
	CONSTRAINT "normalization_runs_method" CHECK("__new_normalization_runs"."method" in ('leniency-shrunk-v1', 'bradley-terry-v1')),
	CONSTRAINT "normalization_runs_computed_iso" CHECK(julianday("__new_normalization_runs"."computed_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_normalization_runs`("id", "event_id", "method", "params", "computed_at", "computed_by") SELECT "id", "event_id", "method", "params", "computed_at", "computed_by" FROM `normalization_runs`;--> statement-breakpoint
DROP TABLE `normalization_runs`;--> statement-breakpoint
ALTER TABLE `__new_normalization_runs` RENAME TO `normalization_runs`;--> statement-breakpoint
CREATE TABLE `__new_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`submitted_at` text,
	`updated_at` text NOT NULL,
	`conflicted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scores_updated_at_iso" CHECK(julianday("__new_scores"."updated_at") is not null),
	CONSTRAINT "scores_submitted_at_iso" CHECK("__new_scores"."submitted_at" is null or julianday("__new_scores"."submitted_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_scores`("id", "assignment_id", "submitted_at", "updated_at", "conflicted") SELECT "id", "assignment_id", "submitted_at", "updated_at", "conflicted" FROM `scores`;--> statement-breakpoint
DROP TABLE `scores`;--> statement-breakpoint
ALTER TABLE `__new_scores` RENAME TO `scores`;--> statement-breakpoint
CREATE UNIQUE INDEX `scores_assignment_id_unique` ON `scores` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `__new_voters` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`email` text,
	`token_hash` text,
	`order_seed` integer NOT NULL,
	`ip_hash` text,
	`agent_hash` text,
	`created_at` text NOT NULL,
	`last_voted_at` text,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "voters_kind_check" CHECK("__new_voters"."kind" in ('account', 'listed', 'link')),
	CONSTRAINT "voters_kind_identity" CHECK(("__new_voters"."kind" = 'account' and "__new_voters"."user_id" is not null) or ("__new_voters"."kind" = 'listed' and "__new_voters"."email" is not null and "__new_voters"."token_hash" is not null) or ("__new_voters"."kind" = 'link' and "__new_voters"."token_hash" is not null)),
	CONSTRAINT "voters_email_lower" CHECK("__new_voters"."email" is null or "__new_voters"."email" = lower("__new_voters"."email")),
	CONSTRAINT "voters_void_reason" CHECK("__new_voters"."voided_at" is null or length(trim(coalesce("__new_voters"."void_reason", ''))) >= 3),
	CONSTRAINT "voters_voided_by" CHECK(("__new_voters"."voided_at" is null) = ("__new_voters"."voided_by" is null)),
	CONSTRAINT "voters_created_iso" CHECK(julianday("__new_voters"."created_at") is not null),
	CONSTRAINT "voters_last_voted_iso" CHECK("__new_voters"."last_voted_at" is null or julianday("__new_voters"."last_voted_at") is not null),
	CONSTRAINT "voters_voided_iso" CHECK("__new_voters"."voided_at" is null or julianday("__new_voters"."voided_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_voters`("id", "event_id", "kind", "user_id", "email", "token_hash", "order_seed", "ip_hash", "agent_hash", "created_at", "last_voted_at", "voided_at", "voided_by", "void_reason") SELECT "id", "event_id", "kind", "user_id", "email", "token_hash", "order_seed", "ip_hash", "agent_hash", "created_at", "last_voted_at", "voided_at", "voided_by", "void_reason" FROM `voters`;--> statement-breakpoint
DROP TABLE `voters`;--> statement-breakpoint
ALTER TABLE `__new_voters` RENAME TO `voters`;--> statement-breakpoint
CREATE UNIQUE INDEX `voters_token_hash_unique` ON `voters` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `voters_event_user_uq` ON `voters` (`event_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `voters_event_email_uq` ON `voters` (`event_id`,`email`);--> statement-breakpoint
CREATE INDEX `voters_event_ip_idx` ON `voters` (`event_id`,`ip_hash`);--> statement-breakpoint
CREATE TABLE `__new_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`audit_id` integer,
	`action` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`last_attempt_at` text,
	`response_status` integer,
	`response_body` text,
	`error` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audit_id`) REFERENCES `audit_log`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_deliveries_status" CHECK("__new_webhook_deliveries"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_attempts" CHECK("__new_webhook_deliveries"."attempts" between 0 and 20),
	CONSTRAINT "webhook_deliveries_created_iso" CHECK(julianday("__new_webhook_deliveries"."created_at") is not null),
	CONSTRAINT "webhook_deliveries_next_iso" CHECK("__new_webhook_deliveries"."next_attempt_at" is null or julianday("__new_webhook_deliveries"."next_attempt_at") is not null),
	CONSTRAINT "webhook_deliveries_last_iso" CHECK("__new_webhook_deliveries"."last_attempt_at" is null or julianday("__new_webhook_deliveries"."last_attempt_at") is not null),
	CONSTRAINT "webhook_deliveries_delivered_iso" CHECK("__new_webhook_deliveries"."delivered_at" is null or julianday("__new_webhook_deliveries"."delivered_at") is not null)
);
--> statement-breakpoint
INSERT INTO `__new_webhook_deliveries`("id", "webhook_id", "audit_id", "action", "payload", "status", "attempts", "next_attempt_at", "last_attempt_at", "response_status", "response_body", "error", "created_at", "delivered_at") SELECT "id", "webhook_id", "audit_id", "action", "payload", "status", "attempts", "next_attempt_at", "last_attempt_at", "response_status", "response_body", "error", "created_at", "delivered_at" FROM `webhook_deliveries`;--> statement-breakpoint
DROP TABLE `webhook_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_webhook_deliveries` RENAME TO `webhook_deliveries`;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_hook_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);
--> statement-breakpoint
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
