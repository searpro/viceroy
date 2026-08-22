-- M7 PR2 — Concept through structure.
--
-- Hand-written rather than `drizzle-kit generate` output verbatim: this
-- repo's `drizzle/meta` snapshots stopped being updated after 0007 (0008-0013
-- were all hand-authored too), so a fresh `generate` diffs the current schema
-- against that stale 0007 snapshot and re-proposes every table/column added
-- since — `dev_artifacts`, `workflows`, `image_styles.render_guidance`, and
-- so on — all of which already exist in any database that has run 0008-0013.
-- Only the statements below are actually new in this migration.

-- "characters+arcs" (M7 PR2) extends the existing `characters` table rather
-- than writing to `dev_artifacts` — see `DEV_CHAIN_STAGES` in lib/db/schema.ts.
ALTER TABLE `characters` ADD `arc` text;--> statement-breakpoint

-- Direction Style: feeds only the *text* register of the Development chain's
-- prompts (concept/logline/characters+arcs/world building/story structure).
-- Never referenced from an image-generation prompt path — that stays Image
-- Style's alone (ADR 0002).
CREATE TABLE `direction_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`genre_guidance` text NOT NULL,
	`tone_guidance` text NOT NULL,
	`pacing_guidance` text NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `direction_styles_name_unique` ON `direction_styles` (`name`);--> statement-breakpoint

ALTER TABLE `projects` ADD `direction_style_id` text REFERENCES direction_styles(id);--> statement-breakpoint
-- The "characters+arcs" stage's approval gate and direction-history: it has
-- no `dev_artifacts` row of its own to carry either (see `DEV_CHAIN_STAGES`).
ALTER TABLE `projects` ADD `characters_approved_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `characters_direction_history` text DEFAULT '[]' NOT NULL;--> statement-breakpoint

-- One row per project — rules/tone/theme prose only, not locations or props
-- (those are their own first-class tables below).
CREATE TABLE `world_building` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`approved_at` integer,
	`direction_history` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `world_building_project_idx` ON `world_building` (`project_id`);--> statement-breakpoint

-- Mirrors `characters`' visual-consistency columns (name, description,
-- image_asset_id, ref_input_name, image_source) exactly — see the M7 detail
-- page. `filterLiveRefs` (lib/pipeline/images.ts) applies to these unchanged.
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image_asset_id` text,
	`ref_input_name` text,
	`image_source` text DEFAULT 'generated' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `locations_project_idx` ON `locations` (`project_id`);--> statement-breakpoint

-- Same shape as `locations`, same reasoning.
CREATE TABLE `props` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image_asset_id` text,
	`ref_input_name` text,
	`image_source` text DEFAULT 'generated' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `props_project_idx` ON `props` (`project_id`);
