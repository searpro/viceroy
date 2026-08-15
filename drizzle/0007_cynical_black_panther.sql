ALTER TABLE `providers` ADD `negative_prompt` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `image_styles` DROP COLUMN `negative_prompt`;--> statement-breakpoint
ALTER TABLE `image_styles` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `image_styles` DROP COLUMN `default_params`;--> statement-breakpoint
ALTER TABLE `voice_styles` DROP COLUMN `model`;