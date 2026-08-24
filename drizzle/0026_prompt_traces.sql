-- Prompt traces — what was actually sent to a provider, not what a stage said
-- it was doing.
--
-- `job_logs` already records the narration ("Generating concept with
-- qwen3-30b"). It cannot answer any of the questions that actually come up
-- when a stage returns something wrong: which template produced this prompt,
-- what did `{{genreGuidance}}` expand to, which provider row got resolved,
-- what did the model send back before JSON extraction chewed on it, and how
-- many steps did the image workflow really run at.
--
-- One table across `llm`/`image`/`video` rather than three, because all three
-- answer the same four questions — which prompt, from which template, against
-- which provider configuration, and what came back — and because a project's
-- generation history is only legible when the LLM and image calls are in one
-- ordered list.
--
-- `sequence` exists because `created_at` is not a reliable tiebreaker: a
-- stage that calls the model once per scene emits rows inside the same
-- millisecond, and the order they went out in is the whole point.
--
-- Cascading from `jobs` mirrors `job_logs`, so "clear finished" on the Jobs
-- screen is also this table's retention policy. Prompts and responses are
-- stored whole and uncapped — a debugging record that truncates the thing
-- being debugged is not one.
CREATE TABLE `trace_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL REFERENCES `jobs`(`id`) ON DELETE cascade,
	`project_id` text REFERENCES `projects`(`id`) ON DELETE cascade,
	`stage` text NOT NULL,
	`kind` text NOT NULL,
	`operation` text NOT NULL,
	`sequence` integer NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`provider_id` text,
	`provider_name` text DEFAULT '' NOT NULL,
	`adapter` text DEFAULT '' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`base_url` text DEFAULT '' NOT NULL,
	`request_path` text DEFAULT '' NOT NULL,
	`templates` text DEFAULT '[]' NOT NULL,
	`request` text DEFAULT '{}' NOT NULL,
	`resolved` text,
	`response` text,
	`response_meta` text,
	`ok` integer DEFAULT true NOT NULL,
	`error` text,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `trace_calls_job_idx` ON `trace_calls` (`job_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `trace_calls_project_idx` ON `trace_calls` (`project_id`,`created_at`);
