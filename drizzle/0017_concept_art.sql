-- M7 PR9 — Concept Art (Preproduction stage 16).
--
-- No new table: `locations`/`props` already carry `image_asset_id`/
-- `ref_input_name`/`image_source` from PR2 (M7's world-building tables) —
-- this stage is their first consumer. Only the approval gate is new, on
-- `projects` — see the column's own comment in lib/db/schema.ts for why it
-- lives there rather than on any one `locations`/`props` row (mirrors
-- `continuity_approved_at`).
ALTER TABLE `projects` ADD `concept_art_approved_at` integer;
