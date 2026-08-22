-- M7 PR10 — Storyboards (Preproduction stage 17).
--
-- One row per generated panel, one panel per beat in the approved scene
-- breakdown — a scene can want more than one panel, so this is not simply
-- one row per scene. `scene_id` is free text, not a `scenes` reference, same
-- reasoning as `continuity_facts.scene_id` (see that migration's own
-- comment): the dev chain's scene breakdown is a prose document, not
-- `scenes` rows. `shot_type`/`camera_angle`/`camera_movement`/`lens` are the
-- structured cinematography fields the M7 detail page's Style-system section
-- scoped ahead of time — a closed vocabulary each, independently editable,
-- never baked into `panel_image_prompt` as the only place they show up.
CREATE TABLE `storyboard_panels` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`scene_id` text NOT NULL,
	`index` integer NOT NULL,
	`panel_image_prompt` text DEFAULT '' NOT NULL,
	`shot_type` text DEFAULT 'medium' NOT NULL,
	`camera_angle` text DEFAULT 'eye-level' NOT NULL,
	`camera_movement` text DEFAULT 'static' NOT NULL,
	`lens` text DEFAULT 'standard' NOT NULL,
	`panel_image_asset_id` text REFERENCES `assets`(`id`),
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `storyboard_panels_project_idx` ON `storyboard_panels` (`project_id`);--> statement-breakpoint
CREATE INDEX `storyboard_panels_project_scene_idx` ON `storyboard_panels` (`project_id`,`scene_id`);--> statement-breakpoint

-- The "storyboards" stage's approval gate — see the column's own comment in
-- lib/db/schema.ts for why it lives on `projects` rather than on any one
-- `storyboard_panels` row (mirrors `concept_art_approved_at`).
ALTER TABLE `projects` ADD `storyboards_approved_at` integer;
