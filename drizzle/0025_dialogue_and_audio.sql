-- M7.2 — dialogue reaches the shot list, and the timeline carries an audio register.
--
-- Dialogue used to die at the script breakdown. The screenplay stage writes
-- it in Fountain, the revision stage grades it against a `dialogue_quality`
-- checklist, the PDF export typesets it — and then `storyboard_panels` and
-- `shot_list_items` carried no field for it, so a finished "movie" reached
-- Production with no words in it.
--
-- That mattered less while the plan was to supply our own TTS track. It is
-- load-bearing now that LTX generates audio natively from the words in its
-- own prompt: the exact authored line has to travel this far to be spoken.
--
-- The audio columns on `timeline_segments` are deliberately separate
-- components (dialogue / ambience / foley / music) rather than one prose
-- field. Each target composes them in its own order — storing LTX's
-- six-element paragraph here would make the timeline LTX's format, which is
-- what this table exists not to be.
ALTER TABLE `shot_list_items` ADD `dialogue` text DEFAULT '[]' NOT NULL;--> statement-breakpoint

ALTER TABLE `timeline_segments` ADD `dialogue` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `timeline_segments` ADD `ambience` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `timeline_segments` ADD `foley` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `timeline_segments` ADD `music` text DEFAULT '' NOT NULL;
