-- M9 — a scene is a span of narration; a shot is one picture covering part of
-- it.
--
-- Today a scene holds a single still for its whole narration span, which on a
-- real project is routinely 15-25 seconds of an unchanging frame. This table
-- is what lets N pictures cover one scene.
--
-- `start_word`/`end_word` are inclusive offsets into the scene's own
-- `voiceover_script`, not into the whole narration, and there is deliberately
-- NO duration column. The ~150 wpm estimate that plans these ranges decides
-- only how many shots exist; where each one sits comes from the aligned words
-- it covers, written by `runSubtitleAlign`. Storing a duration would let the
-- estimate become the timeline, which is exactly the drift F1 and F5 were
-- opened for.
--
-- Nothing is backfilled. A project that finished before M9 has no shots to
-- derive, so `scenes.image_prompt` / `scenes.image_asset_id` stay and the
-- render falls back to them.
CREATE TABLE `scene_shots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`scene_id` text NOT NULL REFERENCES `scenes`(`id`) ON DELETE cascade,
	`index` integer NOT NULL,
	`start_word` integer NOT NULL,
	`end_word` integer NOT NULL,
	`shot_type` text DEFAULT 'medium' NOT NULL,
	`storyboard` text,
	`image_prompt` text,
	`character_ids` text DEFAULT '[]' NOT NULL,
	`image_asset_id` text REFERENCES `assets`(`id`),
	`start_ms` integer,
	`end_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `scene_shots_scene_index_uq` ON `scene_shots` (`scene_id`,`index`);--> statement-breakpoint
CREATE INDEX `scene_shots_project_idx` ON `scene_shots` (`project_id`);--> statement-breakpoint

-- The scene's look in prose, handed to every shot in it so they agree about
-- where they are. Nullable: only scenes visualised after M9 have one.
ALTER TABLE `scenes` ADD `visual_brief` text;--> statement-breakpoint

-- Shot pacing is editorial, so it lives on the narrative style next to
-- `target_scene_count`. It is also the single biggest lever on how long a
-- project takes to generate on this hardware (F12, F30), which is why it is a
-- form field rather than a constant.
ALTER TABLE `narrative_styles` ADD `shot_target_ms` integer DEFAULT 2500 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrative_styles` ADD `shot_min_ms` integer DEFAULT 1500 NOT NULL;--> statement-breakpoint
ALTER TABLE `narrative_styles` ADD `shot_max_ms` integer DEFAULT 3500 NOT NULL;
