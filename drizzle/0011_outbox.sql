CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text,
	`kind` text NOT NULL,
	`to_email` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outbox_kind" CHECK("outbox"."kind" in ('judge_invite', 'voter_link', 'password_reset', 'claim_link', 'judge_reminder', 'admin_setup')),
	CONSTRAINT "outbox_status" CHECK("outbox"."status" in ('sent', 'failed', 'off')),
	CONSTRAINT "outbox_to_email" CHECK("outbox"."to_email" like '%_@_%'),
	CONSTRAINT "outbox_subject_length" CHECK(length("outbox"."subject") between 1 and 200),
	CONSTRAINT "outbox_body_length" CHECK(length("outbox"."body") between 1 and 20000),
	CONSTRAINT "outbox_created_iso" CHECK(julianday("outbox"."created_at") is not null),
	CONSTRAINT "outbox_sent_at" CHECK(("outbox"."status" = 'sent') = ("outbox"."sent_at" is not null))
);
--> statement-breakpoint
CREATE INDEX `outbox_event_idx` ON `outbox` (`event_id`,`created_at`);