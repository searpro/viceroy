-- M7 PR12 — Casting (Preproduction stage 20).
--
-- `casting_locked_at` is the identity lock the M7 detail page's "Casting"
-- section already named as the goal: once set, a portrait/voice redo on this
-- character is refused until an explicit unlock clears it again (see
-- `unlockCasting`/`regenerate()` in lib/projects.ts) — never a silent
-- overwrite. `voice_design_notes` is the minimal "voice design sign-off"
-- half of the spec: free text only, not a generated audio sample or a TTS
-- call — no per-character voice mechanism exists anywhere in this codebase
-- yet (narrative-pipeline voice styles are project-level), and building one
-- is unscoped beyond this PR's brief.
ALTER TABLE `characters` ADD `casting_locked_at` integer;--> statement-breakpoint
ALTER TABLE `characters` ADD `voice_design_notes` text;
