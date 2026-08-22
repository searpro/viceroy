-- M7 PR7 — Continuity (Preproduction stage 13).
--
-- Facts extracted from the Story Bible plus the script/scene breakdowns — a
-- character's scar, where a prop was left, a location's established
-- geography — flagged for human review rather than silently trusted. See
-- `continuityFacts` in lib/db/schema.ts for why `subject_id` carries no DB-
-- level FK and `scene_id` is free text, not a `scenes` reference.
CREATE TABLE `continuity_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL REFERENCES `projects`(`id`) ON DELETE cascade,
	`scene_id` text,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`subject_name` text NOT NULL,
	`fact` text NOT NULL,
	`source` text DEFAULT 'extracted' NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `continuity_facts_project_idx` ON `continuity_facts` (`project_id`);--> statement-breakpoint
CREATE INDEX `continuity_facts_subject_idx` ON `continuity_facts` (`project_id`,`subject_id`);--> statement-breakpoint

-- The "continuity" stage's approval gate — see the column's own comment in
-- lib/db/schema.ts for why it lives on `projects` rather than on any one
-- `continuity_facts` row (mirrors `characters_approved_at`).
ALTER TABLE `projects` ADD `continuity_approved_at` integer;
