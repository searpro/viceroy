-- Split art direction into "what the world looks like" (narrative style) and
-- "how it is rendered" (image style). See ADR 0002.
--
-- `visual_guidance` carried both, which is why a character portrait — which
-- has settings and framing stripped out of it — ended up generated in a
-- different register from the scenes that use it as a reference image.
--
-- The rename preserves user-authored styles: the existing text stays as the
-- scene half, which is what the majority of it always described. The rendering
-- half is seeded onto the built-in image styles and left empty for custom
-- ones, where an empty string degrades to today's behaviour.
ALTER TABLE `narrative_styles` RENAME COLUMN `visual_guidance` TO `scene_guidance`;--> statement-breakpoint
ALTER TABLE `image_styles` ADD `render_guidance` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `image_styles` ADD `negative_prompt` text DEFAULT '' NOT NULL;
