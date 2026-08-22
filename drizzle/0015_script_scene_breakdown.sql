-- M7 PR6 — Script & scene breakdown (Preproduction stages 11-12).
--
-- `script_breakdown`/`scene_breakdown` are two new `dev_artifacts.stage`
-- values, not new columns — that enum lives only in TypeScript (see
-- `DEV_ARTIFACT_STAGES` in lib/db/schema.ts), so no DDL is needed for them.

-- Production Design Style: same shape as `direction_styles`, a different
-- register (ADR 0002) — visual language / palette / texture guidance for
-- Preproduction's own aesthetic text prompts. Nothing reads this yet; the
-- production-design stage that consumes it is PR8's scope.
CREATE TABLE `production_design_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`visual_language_guidance` text NOT NULL,
	`palette_guidance` text NOT NULL,
	`texture_guidance` text NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `production_design_styles_name_unique` ON `production_design_styles` (`name`);--> statement-breakpoint

ALTER TABLE `projects` ADD `production_design_style_id` text REFERENCES production_design_styles(id);
