-- M7.1 PR-C — Wardrobe variants.
--
-- A character's identity is locked; their clothes are not. A story that runs
-- a character through two situations wants them recognisably the same person
-- in different outfits, which the reference pack (PR-B) could not express: it
-- held exactly one body view per character, so either every panel showed the
-- same outfit or the outfit drifted freely.
--
-- A variant is an approved outfit for one character, with its own body views
-- in the pack. Head and expression views stay wardrobe-independent
-- (`wardrobe_variant_id` NULL) — they are crops of a face, and generating
-- three expressions per outfit would multiply the most expensive stage in the
-- chain for nothing.
CREATE TABLE `wardrobe_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE cascade,
	`name` text NOT NULL,
	`description` text NOT NULL,
	-- Exactly one per character is the default, and it is what any panel that
	-- names no variant uses. Not a separate "default_variant_id" on
	-- `characters`: that would let a character point at another character's
	-- variant, which this cannot express.
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `wardrobe_variants_character_idx` ON `wardrobe_variants` (`character_id`);--> statement-breakpoint

ALTER TABLE `character_reference_images` ADD `wardrobe_variant_id` text REFERENCES `wardrobe_variants`(`id`) ON DELETE cascade;--> statement-breakpoint

-- PR-B's uniqueness was (character, view), which stops being right the moment
-- one character has two body_front views for two outfits. Replaced rather than
-- edited — 0021 has shipped and this repo's migrations are append-only.
--
-- `ifnull(...,'')` rather than the bare column because SQLite treats NULLs as
-- distinct in a UNIQUE index: with the column raw, a character could
-- accumulate any number of NULL-variant `head_front` rows and the constraint
-- would silently permit exactly the ambiguity it exists to prevent.
DROP INDEX `character_reference_images_character_view_unq`;--> statement-breakpoint
CREATE UNIQUE INDEX `character_reference_images_character_view_variant_unq` ON `character_reference_images` (`character_id`,`view`,ifnull(`wardrobe_variant_id`,''));--> statement-breakpoint

-- Which character's outfit changes in this panel/shot. Nullable: null means
-- every character wears their default variant, which is what the whole
-- pre-PR-C corpus means and what most panels will keep meaning.
--
-- Deliberately on these two tables and NOT on `scenes` (where the M7.1 plan
-- put it): the Development chain never populates `scenes` at all — its scene
-- breakdown is a prose document, which is why `storyboard_panels.scene_id` and
-- `shot_list_items.scene_id` are free text rather than foreign keys.
--
-- One id, not a set. A variant already belongs to a character, so a single
-- pointer is unambiguous about who it dresses; every other character in the
-- panel keeps their default. A panel needing two simultaneous overrides needs
-- a join table, which nothing has asked for yet.
ALTER TABLE `storyboard_panels` ADD `wardrobe_variant_id` text REFERENCES `wardrobe_variants`(`id`);--> statement-breakpoint
ALTER TABLE `shot_list_items` ADD `wardrobe_variant_id` text REFERENCES `wardrobe_variants`(`id`);
