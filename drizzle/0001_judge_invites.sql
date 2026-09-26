CREATE TABLE `judge_invites` (
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
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "judge_invites_tracks_json" CHECK(json_valid("judge_invites"."track_ids") and json_type("judge_invites"."track_ids") = 'array'),
	CONSTRAINT "judge_invites_email_lower" CHECK("judge_invites"."email" is null or "judge_invites"."email" = lower("judge_invites"."email")),
	CONSTRAINT "judge_invites_one_outcome" CHECK("judge_invites"."accepted_at" is null or "judge_invites"."revoked_at" is null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `judge_invites_code_hash_unique` ON `judge_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `judge_invites_event_idx` ON `judge_invites` (`event_id`);