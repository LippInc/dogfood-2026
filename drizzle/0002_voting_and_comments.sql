CREATE TABLE `comments` (
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
	CONSTRAINT "comments_body_length" CHECK(length(trim("comments"."body")) between 1 and 2000),
	CONSTRAINT "comments_hidden_reason" CHECK("comments"."hidden_at" is null or length(trim(coalesce("comments"."hidden_reason", ''))) >= 3)
);
--> statement-breakpoint
CREATE INDEX `comments_project_idx` ON `comments` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `voters` (
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
	CONSTRAINT "voters_kind_check" CHECK("voters"."kind" in ('account', 'listed', 'link')),
	CONSTRAINT "voters_kind_identity" CHECK(("voters"."kind" = 'account' and "voters"."user_id" is not null) or ("voters"."kind" = 'listed' and "voters"."email" is not null and "voters"."token_hash" is not null) or ("voters"."kind" = 'link' and "voters"."token_hash" is not null)),
	CONSTRAINT "voters_email_lower" CHECK("voters"."email" is null or "voters"."email" = lower("voters"."email")),
	CONSTRAINT "voters_void_reason" CHECK("voters"."voided_at" is null or length(trim(coalesce("voters"."void_reason", ''))) >= 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voters_token_hash_unique` ON `voters` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `voters_event_user_uq` ON `voters` (`event_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `voters_event_email_uq` ON `voters` (`event_id`,`email`);--> statement-breakpoint
CREATE INDEX `voters_event_ip_idx` ON `voters` (`event_id`,`ip_hash`);--> statement-breakpoint
CREATE TABLE `votes` (
	`voter_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`voter_id`, `project_id`),
	FOREIGN KEY (`voter_id`) REFERENCES `voters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `votes_project_idx` ON `votes` (`project_id`);