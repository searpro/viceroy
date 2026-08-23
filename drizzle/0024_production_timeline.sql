-- M7.2 — the production timeline.
--
-- The handoff artifact between Preproduction (M7, ends at `production_plan`)
-- and Production (M8, begins at LTX shot generation). Everything upstream
-- describes what a shot *is*; nothing until now described what occupies which
-- span of the finished film. `runPrevis` assembles exactly that arrangement to
-- lay stills on a Remotion track and then throws it away.
--
-- Two tables rather than columns on `projects`: `timelines` carries the five
-- project-level settings that only mean anything together (the
-- `world_building`/`voiceovers` shape, `approved_at` included), and
-- `timeline_segments` carries one editable row per planned clip.
--
-- There is deliberately NO `start_ms` column. A segment's start is the prefix
-- sum of every earlier segment's `duration_ms`, derived on read. Storing it
-- would let an edited duration leave a stale offset two segments downstream —
-- invisible until a render came out wrong.
CREATE TABLE `timelines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`target_id` text DEFAULT 'ltx-director' NOT NULL,
	`fps` integer DEFAULT 24 NOT NULL,
	`global_prompt` text DEFAULT '' NOT NULL,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `timelines_project_unq` ON `timelines` (`project_id`);--> statement-breakpoint

CREATE TABLE `timeline_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`shot_list_item_id` text REFERENCES `shot_list_items`(`id`) ON DELETE set null,
	`scene_id` text DEFAULT '' NOT NULL,
	`index` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`duration_ms` integer NOT NULL,
	`video_prompt` text DEFAULT '' NOT NULL,
	`keyframe_prompt` text DEFAULT '' NOT NULL,
	`start_keyframe_asset_id` text REFERENCES `assets`(`id`),
	`end_keyframe_asset_id` text REFERENCES `assets`(`id`),
	`guide_strength` real DEFAULT 1 NOT NULL,
	`shot_type` text DEFAULT 'medium' NOT NULL,
	`camera_angle` text DEFAULT 'eye-level' NOT NULL,
	`camera_movement` text DEFAULT 'static' NOT NULL,
	`lens` text DEFAULT 'standard' NOT NULL,
	`character_ids` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `timeline_segments_project_idx` ON `timeline_segments` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `timeline_segments_project_index_unq` ON `timeline_segments` (`project_id`,`index`);
