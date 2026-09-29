-- The organizers' updates to an event (event_updates) and the outbox kind for mailing one to the event's
-- participants (event_update). Updates are news, not results: they may be posted, edited and removed after
-- publishing, so the table has no freeze triggers. SQLite cannot change a CHECK in place, so the outbox is rebuilt
-- with the same columns and rows, as 0015 did; nothing refers to it and it has no triggers. migrate.ts switches
-- foreign-key enforcement off around the migrator (a PRAGMA inside its transaction does nothing).
CREATE TABLE `event_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`edited_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_updates_title_length" CHECK(length(trim("event_updates"."title")) between 1 and 120),
	CONSTRAINT "event_updates_body_length" CHECK(length(trim("event_updates"."body")) between 1 and 5000),
	CONSTRAINT "event_updates_created_iso" CHECK(julianday("event_updates"."created_at") is not null),
	CONSTRAINT "event_updates_edited_iso" CHECK("event_updates"."edited_at" is null or julianday("event_updates"."edited_at") is not null)
);
--> statement-breakpoint
CREATE INDEX `event_updates_event_idx` ON `event_updates` (`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_outbox` (
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
	CONSTRAINT "outbox_kind" CHECK("__new_outbox"."kind" in ('judge_invite', 'voter_link', 'password_reset', 'claim_link', 'judge_reminder', 'admin_setup', 'event_update')),
	CONSTRAINT "outbox_status" CHECK("__new_outbox"."status" in ('sending', 'sent', 'failed', 'unknown', 'off')),
	CONSTRAINT "outbox_to_email" CHECK("__new_outbox"."to_email" like '%_@_%'),
	CONSTRAINT "outbox_subject_length" CHECK(length("__new_outbox"."subject") between 1 and 200),
	CONSTRAINT "outbox_body_length" CHECK(length("__new_outbox"."body") between 1 and 20000),
	CONSTRAINT "outbox_created_iso" CHECK(julianday("__new_outbox"."created_at") is not null),
	CONSTRAINT "outbox_sent_at" CHECK(("__new_outbox"."status" = 'sent') = ("__new_outbox"."sent_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "event_id", "kind", "to_email", "subject", "body", "status", "error", "created_by", "created_at", "sent_at") SELECT "id", "event_id", "kind", "to_email", "subject", "body", "status", "error", "created_by", "created_at", "sent_at" FROM `outbox`;--> statement-breakpoint
DROP TABLE `outbox`;--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;--> statement-breakpoint
CREATE INDEX `outbox_event_idx` ON `outbox` (`event_id`,`created_at`);