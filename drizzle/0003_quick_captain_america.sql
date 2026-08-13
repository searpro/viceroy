CREATE TABLE `caption_styles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`font_family` text DEFAULT 'Inter, system-ui, -apple-system, sans-serif' NOT NULL,
	`font_size` integer DEFAULT 76 NOT NULL,
	`font_weight` integer DEFAULT 800 NOT NULL,
	`color` text DEFAULT '#ffffff' NOT NULL,
	`outline_color` text DEFAULT '#000000' NOT NULL,
	`outline_width` integer DEFAULT 10 NOT NULL,
	`bottom_offset` real DEFAULT 0.17 NOT NULL,
	`uppercase` integer DEFAULT false NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `caption_styles_name_unique` ON `caption_styles` (`name`);--> statement-breakpoint
ALTER TABLE `projects` ADD `caption_style_id` text REFERENCES caption_styles(id);