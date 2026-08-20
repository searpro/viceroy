-- Teach providers which protocol their host speaks, and give ComfyUI rows
-- somewhere to keep a workflow.
--
-- Until now "provider" meant "a host that speaks the protocol this kind
-- happens to use" — the call shape was hardcoded per kind, so an image
-- provider was always sd-api and a video provider was always vllm-omni.
-- ComfyUI breaks that: it has no per-kind endpoint and no notion of `model`
-- at all, it takes a whole workflow graph. So the row has to say which
-- protocol it is, and carry the graph.

ALTER TABLE `providers` ADD `adapter` text DEFAULT 'sdapi' NOT NULL;--> statement-breakpoint
ALTER TABLE `providers` ADD `compute` text;--> statement-breakpoint

-- vllm-omni is retired: ComfyUI is now the only video backend. Existing video
-- rows are relabelled rather than deleted — they are the user's rows, and the
-- base URL they carry is the only record of where that host was. They will
-- have no workflow until one is pasted in, and `resolveWorkflow` fails with a
-- message naming the missing role, which is the honest outcome: a video
-- provider that cannot generate video should say so at resolve time rather
-- than 404 against a dead host halfway through a render.
UPDATE `providers` SET `adapter` = 'comfyui' WHERE `kind` = 'video';--> statement-breakpoint

CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`graph` text NOT NULL,
	`variables` text DEFAULT '[]' NOT NULL,
	`output_node_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint

-- One workflow per role per provider. Without this the pipeline's
-- (provider, role) lookup would be order-dependent in exactly the way
-- `is_default` exists to prevent for providers themselves.
CREATE UNIQUE INDEX `workflows_provider_role_unq` ON `workflows` (`provider_id`,`role`);
