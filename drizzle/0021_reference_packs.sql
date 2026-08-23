-- M7.1 PR-B — Character Canonical Reference Packs (Preproduction stage 16).
--
-- Casting already produced exactly one image per character: a single
-- head-and-shoulders portrait, stored on `characters.image_asset_id` and
-- uploaded as the one reference every downstream panel could cite. That is
-- enough to hold a face in a close-up and not much else — a wide shot
-- conditioned on a head crop has nothing to say about the character's build,
-- posture or clothing, so those drift panel to panel even though "identity" is
-- nominally locked.
--
-- A reference pack is several views of the same locked identity, so a stage
-- can cite the view that matches the shot it is drawing. `characters`'
-- existing columns are deliberately left alone and keep meaning what they
-- meant: the canonical head-front anchor. Every other view is a row here,
-- generated *from* that anchor, so the pack is internally consistent by
-- construction rather than by luck.
--
-- `wardrobe_variant_id` is deliberately absent — wardrobe is M7.1 PR-C's
-- concern and arrives as its own ALTER TABLE, per this repo's append-only
-- migration rule.
CREATE TABLE `character_reference_images` (
	`id` text PRIMARY KEY NOT NULL,
	`character_id` text NOT NULL REFERENCES `characters`(`id`) ON DELETE cascade,
	`view` text NOT NULL,
	`prompt` text DEFAULT '' NOT NULL,
	`image_asset_id` text REFERENCES `assets`(`id`),
	`ref_input_name` text,
	`image_source` text DEFAULT 'generated' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `character_reference_images_character_idx` ON `character_reference_images` (`character_id`);--> statement-breakpoint
-- One row per (character, view). The pack is a fixed set of named views, not a
-- gallery — a second "head_side" for the same character would make "which one
-- anchors a profile shot" order-dependent, the same ambiguity
-- `workflows_provider_role_unq` exists to prevent for provider workflows.
-- Safe as a plain UNIQUE index because neither column is nullable; SQLite
-- treats NULLs as distinct, which would have made this no constraint at all.
CREATE UNIQUE INDEX `character_reference_images_character_view_unq` ON `character_reference_images` (`character_id`,`view`);
