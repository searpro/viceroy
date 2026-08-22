-- M7 PR1 — Format & fork.
--
-- A project now says what kind of thing it's making. `short_video_narrative`
-- is today's only format, and every project that predates this column gets
-- it by default, so the narrative pipeline above keeps running exactly as it
-- always has. Every other format routes through the new Development chain
-- instead, whose artifacts live in `dev_artifacts` rather than `scenes`/
-- `characters` — those mean something specific to the narrative pipeline,
-- and reusing them for a screenplay would make a dev-format project's
-- `elements` redo touch rows it has no business touching.
ALTER TABLE `projects` ADD `format` text DEFAULT 'short_video_narrative' NOT NULL;--> statement-breakpoint

CREATE TABLE `dev_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`stage` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`content` text NOT NULL,
	`approved_at` integer,
	`direction_history` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `dev_artifacts_project_idx` ON `dev_artifacts` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dev_artifacts_project_stage_version_idx` ON `dev_artifacts` (`project_id`,`stage`,`version`);
