CREATE TABLE `signed_records` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`key_id` text NOT NULL,
	`envelope` text NOT NULL,
	`issued_at` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`key_id`) REFERENCES `signing_keys`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "signed_records_kind" CHECK("signed_records"."kind" in ('judge', 'participant')),
	CONSTRAINT "signed_records_issued_iso" CHECK(julianday("signed_records"."issued_at") is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signed_records_once` ON `signed_records` (`event_id`,`kind`,`user_id`);--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`public_jwk` text NOT NULL,
	`private_pkcs8` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "signing_keys_created_iso" CHECK(julianday("signing_keys"."created_at") is not null)
);
