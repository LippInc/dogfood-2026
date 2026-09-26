CREATE TABLE `assignment_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`mode` text NOT NULL,
	`seed` integer NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assignment_runs_mode_check" CHECK("assignment_runs"."mode" in ('fixture', 'fresh', 'topup')),
	CONSTRAINT "assignment_runs_params_json" CHECK(json_valid("assignment_runs"."params"))
);
--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`judge_user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`batch_no` integer DEFAULT 1 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`judge_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `assignment_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`event_id`) REFERENCES `projects`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assignments_status_check" CHECK("assignments"."status" in ('pending', 'done', 'recused')),
	CONSTRAINT "assignments_batch_positive" CHECK("assignments"."batch_no" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignments_judge_project_uq` ON `assignments` (`judge_user_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `assignments_project_idx` ON `assignments` (`project_id`);--> statement-breakpoint
CREATE INDEX `assignments_event_judge_idx` ON `assignments` (`event_id`,`judge_user_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor_user_id` text,
	`actor_label` text NOT NULL,
	`action` text NOT NULL,
	`event_id` text,
	`target_type` text,
	`target_id` text,
	`before` text,
	`after` text,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	CONSTRAINT "audit_at_iso" CHECK(julianday("audit_log"."at") is not null),
	CONSTRAINT "audit_hash_format" CHECK(length("audit_log"."hash") = 64 and length("audit_log"."prev_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_log_hash_unique` ON `audit_log` (`hash`);--> statement-breakpoint
CREATE INDEX `audit_event_idx` ON `audit_log` (`event_id`,`id`);--> statement-breakpoint
CREATE TABLE `custom_answers` (
	`project_id` text NOT NULL,
	`question_id` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`project_id`, `question_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `custom_questions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `custom_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`label` text NOT NULL,
	`help` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'longtext' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "custom_questions_type_check" CHECK("custom_questions"."type" in ('text', 'longtext', 'url'))
);
--> statement-breakpoint
CREATE TABLE `events` (
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
	CONSTRAINT "events_slug_format" CHECK("events"."slug" glob '[a-z0-9]*' and "events"."slug" not glob '*[^a-z0-9-]*'),
	CONSTRAINT "events_close_iso" CHECK(julianday("events"."submissions_close_at") is not null),
	CONSTRAINT "events_window_order" CHECK("events"."submissions_open_at" is null or julianday("events"."submissions_open_at") < julianday("events"."submissions_close_at")),
	CONSTRAINT "events_voting_order" CHECK("events"."voting_open_at" is null or "events"."voting_close_at" is null or julianday("events"."voting_open_at") < julianday("events"."voting_close_at")),
	CONSTRAINT "events_settings_json" CHECK(json_valid("events"."settings"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);--> statement-breakpoint
CREATE TABLE `fixture_imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`sha256` text NOT NULL,
	`imported_at` text NOT NULL,
	`counts` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `judge_overrides` (
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
	CONSTRAINT "judge_overrides_mode_check" CHECK("judge_overrides"."mode" in ('include', 'exclude')),
	CONSTRAINT "judge_overrides_reason_nonempty" CHECK(length(trim("judge_overrides"."reason")) >= 3)
);
--> statement-breakpoint
CREATE TABLE `judge_tracks` (
	`judge_user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`track_id` text NOT NULL,
	PRIMARY KEY(`judge_user_id`, `event_id`, `track_id`),
	FOREIGN KEY (`judge_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`,`event_id`) REFERENCES `tracks`(`id`,`event_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `normalization_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`method` text NOT NULL,
	`params` text NOT NULL,
	`computed_at` text NOT NULL,
	`computed_by` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "normalization_runs_params_json" CHECK(json_valid("normalization_runs"."params"))
);
--> statement-breakpoint
CREATE TABLE `normalized_scores` (
	`run_id` text NOT NULL,
	`project_id` text NOT NULL,
	`n` integer NOT NULL,
	`raw_mean` real,
	`normalized_mean` real,
	`rank_raw` real,
	`rank_normalized` real,
	PRIMARY KEY(`run_id`, `project_id`),
	FOREIGN KEY (`run_id`) REFERENCES `normalization_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `prizes` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`team_id` text NOT NULL,
	`track_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`repo_url` text,
	`video_url` text,
	`live_url` text,
	`thumbnail_url` text,
	`gallery_urls` text DEFAULT '[]' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`submitted_at` text,
	`duplicate_of` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`,`event_id`) REFERENCES `teams`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`,`event_id`) REFERENCES `tracks`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_of`,`event_id`) REFERENCES `projects`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "projects_status_check" CHECK("projects"."status" in ('draft', 'submitted')),
	CONSTRAINT "projects_submitted_has_time" CHECK("projects"."status" = 'draft' or "projects"."submitted_at" is not null),
	CONSTRAINT "projects_title_nonempty" CHECK(length(trim("projects"."title")) > 0),
	CONSTRAINT "projects_not_own_duplicate" CHECK("projects"."duplicate_of" is null or "projects"."duplicate_of" <> "projects"."id"),
	CONSTRAINT "projects_gallery_json" CHECK(json_valid("projects"."gallery_urls") and json_valid("projects"."tags"))
);
--> statement-breakpoint
CREATE INDEX `projects_event_idx` ON `projects` (`event_id`);--> statement-breakpoint
CREATE INDEX `projects_track_idx` ON `projects` (`track_id`);--> statement-breakpoint
CREATE INDEX `projects_team_idx` ON `projects` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_id_event_uq` ON `projects` (`id`,`event_id`);--> statement-breakpoint
CREATE TABLE `rubric_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`scale_min` integer DEFAULT 1 NOT NULL,
	`scale_max` integer DEFAULT 5 NOT NULL,
	`anchors` text DEFAULT '{}' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rubric_weight_positive" CHECK("rubric_criteria"."weight" > 0),
	CONSTRAINT "rubric_scale_order" CHECK("rubric_criteria"."scale_min" >= 0 and "rubric_criteria"."scale_min" < "rubric_criteria"."scale_max" and "rubric_criteria"."scale_max" <= 100),
	CONSTRAINT "rubric_anchors_json" CHECK(json_valid("rubric_criteria"."anchors"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rubric_event_key_uq` ON `rubric_criteria` (`event_id`,`key`);--> statement-breakpoint
CREATE TABLE `score_comments` (
	`score_id` text PRIMARY KEY NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`private_note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`score_id`) REFERENCES `scores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `score_items` (
	`score_id` text NOT NULL,
	`criterion_id` text NOT NULL,
	`value` integer NOT NULL,
	PRIMARY KEY(`score_id`, `criterion_id`),
	FOREIGN KEY (`score_id`) REFERENCES `scores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`criterion_id`) REFERENCES `rubric_criteria`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `scores` (
	`id` text PRIMARY KEY NOT NULL,
	`assignment_id` text NOT NULL,
	`submitted_at` text,
	`updated_at` text NOT NULL,
	`conflicted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`assignment_id`) REFERENCES `assignments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scores_updated_at_iso" CHECK(julianday("scores"."updated_at") is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scores_assignment_id_unique` ON `scores` (`assignment_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'login' NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_kind_check" CHECK("sessions"."kind" in ('login', 'checker')),
	CONSTRAINT "sessions_label_check" CHECK(("sessions"."kind" = 'checker') = ("sessions"."label" is not null)),
	CONSTRAINT "sessions_expires_at_iso" CHECK(julianday("sessions"."expires_at") is not null)
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_checker_label_uq` ON `sessions` (`label`);--> statement-breakpoint
CREATE TABLE `team_members` (
	`event_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`,`event_id`) REFERENCES `teams`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "team_members_role_check" CHECK("team_members"."role" in ('captain', 'member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_members_one_team_per_event_uq` ON `team_members` (`event_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`invite_code` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_invite_code_unique` ON `teams` (`invite_code`);--> statement-breakpoint
CREATE INDEX `teams_event_idx` ON `teams` (`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_id_event_uq` ON `teams` (`id`,`event_id`);--> statement-breakpoint
CREATE TABLE `tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_event_name_uq` ON `tracks` (`event_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `tracks_id_event_uq` ON `tracks` (`id`,`event_id`);--> statement-breakpoint
CREATE TABLE `user_roles` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`, `role`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_roles_role_check" CHECK("user_roles"."role" in ('organizer', 'judge', 'participant'))
);
--> statement-breakpoint
CREATE INDEX `user_roles_event_role_idx` ON `user_roles` (`event_id`,`role`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK("users"."email" = lower("users"."email") and instr("users"."email", '@') > 1),
	CONSTRAINT "users_created_at_iso" CHECK(julianday("users"."created_at") is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);