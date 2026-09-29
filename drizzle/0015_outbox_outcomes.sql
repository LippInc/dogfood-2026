-- The outbox records a message before it is handed to the mail server ('sending') and then its outcome:
-- 'sent', 'failed' (the server refused it or was never reached, so it did not go out) or 'unknown' (the
-- connection broke after the message was handed over, so it may have arrived). SQLite cannot change a CHECK
-- in place, so the table is rebuilt with the same columns and rows; nothing else refers to it and it has no
-- triggers.
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
	CONSTRAINT "outbox_kind" CHECK("__new_outbox"."kind" in ('judge_invite', 'voter_link', 'password_reset', 'claim_link', 'judge_reminder', 'admin_setup')),
	CONSTRAINT "outbox_status" CHECK("__new_outbox"."status" in ('sending', 'sent', 'failed', 'unknown', 'off')),
	CONSTRAINT "outbox_to_email" CHECK("__new_outbox"."to_email" like '%_@_%'),
	CONSTRAINT "outbox_subject_length" CHECK(length("__new_outbox"."subject") between 1 and 200),
	CONSTRAINT "outbox_body_length" CHECK(length("__new_outbox"."body") between 1 and 20000),
	CONSTRAINT "outbox_created_iso" CHECK(julianday("__new_outbox"."created_at") is not null),
	CONSTRAINT "outbox_sent_at" CHECK(("__new_outbox"."status" = 'sent') = ("__new_outbox"."sent_at" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_outbox`("id", "event_id", "kind", "to_email", "subject", "body", "status", "error", "created_by", "created_at", "sent_at") SELECT "id", "event_id", "kind", "to_email", "subject", "body", "status", "error", "created_by", "created_at", "sent_at" FROM `outbox`;
--> statement-breakpoint
DROP TABLE `outbox`;
--> statement-breakpoint
ALTER TABLE `__new_outbox` RENAME TO `outbox`;
--> statement-breakpoint
CREATE INDEX `outbox_event_idx` ON `outbox` (`event_id`,`created_at`);
