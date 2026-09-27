CREATE TABLE `comparisons` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`judge_user_id` text NOT NULL,
	`track_id` text NOT NULL,
	`left_project_id` text NOT NULL,
	`right_project_id` text NOT NULL,
	`new_project_id` text NOT NULL,
	`outcome` text NOT NULL,
	`created_at` text NOT NULL,
	`voided_at` text,
	FOREIGN KEY (`judge_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`left_project_id`,`event_id`) REFERENCES `projects`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`right_project_id`,`event_id`) REFERENCES `projects`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`track_id`,`event_id`) REFERENCES `tracks`(`id`,`event_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comparisons_outcome_check" CHECK("comparisons"."outcome" in ('left', 'right', 'tie')),
	CONSTRAINT "comparisons_two_projects" CHECK("comparisons"."left_project_id" <> "comparisons"."right_project_id"),
	CONSTRAINT "comparisons_new_is_shown" CHECK("comparisons"."new_project_id" in ("comparisons"."left_project_id", "comparisons"."right_project_id")),
	CONSTRAINT "comparisons_created_iso" CHECK(julianday("comparisons"."created_at") is not null),
	CONSTRAINT "comparisons_voided_iso" CHECK("comparisons"."voided_at" is null or julianday("comparisons"."voided_at") is not null)
);
--> statement-breakpoint
CREATE INDEX `comparisons_event_judge_idx` ON `comparisons` (`event_id`,`judge_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `comparisons_once` ON `comparisons` (`event_id`,`judge_user_id`,`left_project_id`,`right_project_id`) WHERE voided_at is null;