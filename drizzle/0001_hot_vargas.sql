PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`index` integer NOT NULL,
	`description` text NOT NULL,
	`storyboard` text,
	`image_prompt` text,
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
INSERT INTO `__new_scenes`("id", "project_id", "index", "description", "storyboard", "image_prompt", "voiceover_script", "voice_cues", "character_ids", "image_asset_id", "approved_at", "start_ms", "end_ms", "created_at", "updated_at") SELECT "id", "project_id", "index", "description", "storyboard", "image_prompt", "voiceover_script", "voice_cues", "character_ids", "image_asset_id", "approved_at", "start_ms", "end_ms", "created_at", "updated_at" FROM `scenes`;--> statement-breakpoint
DROP TABLE `scenes`;--> statement-breakpoint
ALTER TABLE `__new_scenes` RENAME TO `scenes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `scenes_project_index_uq` ON `scenes` (`project_id`,`index`);--> statement-breakpoint
ALTER TABLE `characters` ADD `appearance_tag` text;