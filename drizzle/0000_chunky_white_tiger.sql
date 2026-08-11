CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`image_prompt` text,
	`image_asset_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `characters_project_idx` ON `characters` (`project_id`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`iteration` integer NOT NULL,
	`verdict` text NOT NULL,
	`overall_score` real,
	`dimensions` text NOT NULL,
	`issues` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evaluations_project_idx` ON `evaluations` (`project_id`);--> statement-breakpoint
CREATE TABLE `image_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`prompt_prefix` text DEFAULT '' NOT NULL,
	`prompt_suffix` text DEFAULT '' NOT NULL,
	`negative_prompt` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`default_params` text DEFAULT '{}' NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_styles_name_unique` ON `image_styles` (`name`);--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_idx` ON `job_logs` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`project_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`error` text,
	`abort_requested` integer DEFAULT false NOT NULL,
	`external_job_id` text,
	`run_after` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_project_idx` ON `jobs` (`project_id`);--> statement-breakpoint
CREATE TABLE `narrative_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`planner_guidance` text NOT NULL,
	`writing_guidance` text NOT NULL,
	`visual_guidance` text NOT NULL,
	`evaluation_checklist` text NOT NULL,
	`target_scene_count` integer DEFAULT 8 NOT NULL,
	`target_word_count` integer DEFAULT 320 NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `narrative_styles_name_unique` ON `narrative_styles` (`name`);--> statement-breakpoint
CREATE TABLE `preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`idea` text NOT NULL,
	`title` text,
	`synopsis` text,
	`story` text,
	`stage` text DEFAULT 'draft' NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`awaiting_review` integer DEFAULT false NOT NULL,
	`failure_reason` text,
	`narrative_style_id` text,
	`voice_style_id` text,
	`image_style_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`narrative_style_id`) REFERENCES `narrative_styles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voice_style_id`) REFERENCES `voice_styles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`image_style_id`) REFERENCES `image_styles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `projects_stage_idx` ON `projects` (`stage`);--> statement-breakpoint
CREATE TABLE `prompt_templates` (
	`key` text PRIMARY KEY NOT NULL,
	`section` text NOT NULL,
	`label` text NOT NULL,
	`description` text NOT NULL,
	`template` text NOT NULL,
	`variables` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text,
	`model` text NOT NULL,
	`default_params` text DEFAULT '{}' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `providers_kind_idx` ON `providers` (`kind`);--> statement-breakpoint
CREATE TABLE `renders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`fps` integer DEFAULT 30 NOT NULL,
	`caption_style` text NOT NULL,
	`asset_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `renders_project_idx` ON `renders` (`project_id`);--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`index` integer NOT NULL,
	`description` text NOT NULL,
	`storyboard` text NOT NULL,
	`image_prompt` text NOT NULL,
	`voiceover_script` text NOT NULL,
	`voice_cues` text,
	`character_ids` text DEFAULT '[]' NOT NULL,
	`image_asset_id` text,
	`approved_at` integer,
	`start_ms` integer,
	`end_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scenes_project_index_uq` ON `scenes` (`project_id`,`index`);--> statement-breakpoint
CREATE TABLE `subtitle_cues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scene_id` text,
	`index` integer NOT NULL,
	`text` text NOT NULL,
	`heard_text` text,
	`start_ms` integer NOT NULL,
	`end_ms` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scene_id`) REFERENCES `scenes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subtitle_cues_project_index_uq` ON `subtitle_cues` (`project_id`,`index`);--> statement-breakpoint
CREATE TABLE `voice_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`tts_instruct` text NOT NULL,
	`delivery_cues` text NOT NULL,
	`model` text DEFAULT 'qwen3-tts-voicedesign' NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_styles_name_unique` ON `voice_styles` (`name`);--> statement-breakpoint
CREATE TABLE `voiceovers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`script` text NOT NULL,
	`tts_instruct` text NOT NULL,
	`audio_asset_id` text,
	`duration_ms` integer,
	`sample_rate` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audio_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE no action
);
