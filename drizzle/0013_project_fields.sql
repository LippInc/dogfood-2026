CREATE TABLE `project_fields` (
	`event_id` text NOT NULL,
	`field` text NOT NULL,
	`mode` text NOT NULL,
	PRIMARY KEY(`event_id`, `field`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_fields_field" CHECK("project_fields"."field" in ('title', 'summary', 'trackId', 'description', 'repoUrl', 'videoUrl', 'liveUrl', 'thumbnailUrl', 'galleryUrls', 'tags')),
	CONSTRAINT "project_fields_mode" CHECK("project_fields"."mode" in ('required', 'optional', 'hidden')),
	CONSTRAINT "project_fields_track_kept" CHECK("project_fields"."field" <> 'trackId' or "project_fields"."mode" <> 'optional')
);
