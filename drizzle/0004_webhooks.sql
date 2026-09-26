CREATE TABLE `webhook_deliveries` (
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
	CONSTRAINT "webhook_deliveries_status" CHECK("webhook_deliveries"."status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_attempts" CHECK("webhook_deliveries"."attempts" between 0 and 20)
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_hook_idx` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`actions` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`disabled_at` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhooks_url_scheme" CHECK("webhooks"."url" like 'http://%' or "webhooks"."url" like 'https://%'),
	CONSTRAINT "webhooks_created_iso" CHECK(julianday("webhooks"."created_at") is not null)
);
--> statement-breakpoint
CREATE INDEX `webhooks_event_idx` ON `webhooks` (`event_id`);