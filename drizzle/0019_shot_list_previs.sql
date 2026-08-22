-- M7 PR11 — Shot lists & previs (Preproduction stages 18-19).
--
-- `shot_list_items` is a new, dedicated table — NOT the same table M8's own
-- (separate, later) milestone will build for its `shots` — per the M7 detail
-- page's own "Shot lists vs. M8's shots table" resolution. `scene_id` is free
-- text, not a `scenes` reference, same reasoning as `storyboard_panels.scene_id`
-- / `continuity_facts.scene_id`: the dev chain's scene breakdown is a prose
-- document, not `scenes` rows. `character_ids` mirrors `scenes.character_ids`'s
-- own loose-json-array shape rather than a polymorphic FK. `keyframe_prompt`/
-- `motion_prompt` are kept as two distinct fields — collapsing them into one is
-- the documented failure mode M8's own "Prompt engine" section warns against
-- ("Her face lit by a guttering lantern" describes a frame; "slow push in as
-- the flame dies" describes what the camera and the subject do) — carried
-- under the same field names `shots` will use, so a later M8 can copy a row
-- across with defaults added, per the M7 detail page's own resolution.
-- `duration_hint_ms` is a plain millisecond estimate, not the quantised
-- `frames`/`fps` M8 will compute later. `keyframe_asset_id` defaults to the
-- source storyboard panel's own `panel_image_asset_id` — no new image
-- generation happens in this stage.
CREATE TABLE `shot_list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`scene_id` text NOT NULL,
	`index` integer NOT NULL,
	`keyframe_prompt` text DEFAULT '' NOT NULL,
	`motion_prompt` text DEFAULT '' NOT NULL,
	`shot_type` text DEFAULT 'medium' NOT NULL,
	`camera_angle` text DEFAULT 'eye-level' NOT NULL,
	`camera_movement` text DEFAULT 'static' NOT NULL,
	`lens` text DEFAULT 'standard' NOT NULL,
	`character_ids` text DEFAULT '[]' NOT NULL,
	`duration_hint_ms` integer,
	`keyframe_asset_id` text REFERENCES `assets`(`id`),
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `shot_list_items_project_idx` ON `shot_list_items` (`project_id`);--> statement-breakpoint
CREATE INDEX `shot_list_items_project_scene_idx` ON `shot_list_items` (`project_id`,`scene_id`);--> statement-breakpoint

-- The "shot_list" stage's approval gate — see the column's own comment in
-- lib/db/schema.ts for why it lives on `projects` rather than on any one
-- `shot_list_items` row (mirrors `storyboards_approved_at`).
ALTER TABLE `projects` ADD `shot_list_approved_at` integer;--> statement-breakpoint

-- Previs has no separate approval gate of its own: unlike every other
-- table-stage approval column above, this project produces exactly one
-- previs artifact, so "approved" simply means this is set — see the
-- column's own comment in lib/db/schema.ts.
ALTER TABLE `projects` ADD `previs_asset_id` text REFERENCES `assets`(`id`);
