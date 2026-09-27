CREATE TABLE `rate_buckets` (
	`key` text PRIMARY KEY NOT NULL,
	`tokens` real NOT NULL,
	`at` integer NOT NULL,
	`refused` integer NOT NULL,
	CONSTRAINT "rate_buckets_tokens" CHECK("rate_buckets"."tokens" >= 0)
);
--> statement-breakpoint
CREATE INDEX `rate_buckets_at_idx` ON `rate_buckets` (`at`);