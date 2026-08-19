-- Separate model-level artifact terms from style-level aesthetic ones.
--
-- BUG-014 moved negative prompts onto the style so noir's "flat lighting, low
-- contrast" could stop arguing against documentary's available light. It did
-- that by letting the style *replace* the provider's list, which also removed
-- the floor: terms that describe what the image model gets wrong regardless of
-- style — hands, fingers, faces, stray text — then had to be restated in every
-- style, and both built-ins omitted them. A generated frame came back with a
-- hand rendered as a blob.
--
-- The provider now carries the model-level floor and the style carries only its
-- own look; `negativePromptFor` concatenates them.
UPDATE `providers` SET `negative_prompt` =
  'text, watermark, extra fingers, deformed hands, malformed limbs, distorted face'
  WHERE `kind` = 'image';--> statement-breakpoint
UPDATE `image_styles` SET `negative_prompt` =
  'illustration, cartoon, painting, cgi, oversaturated, glossy'
  WHERE `is_builtin` = 1 AND `name` = 'Documentary Realism';--> statement-breakpoint
UPDATE `image_styles` SET `negative_prompt` =
  'illustration, cartoon, painting, cgi, flat lighting, low contrast'
  WHERE `is_builtin` = 1 AND `name` = 'Cinematic Noir';
