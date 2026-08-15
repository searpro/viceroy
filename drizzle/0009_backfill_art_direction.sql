-- Perform the actual split for data that already existed. See ADR 0002.
--
-- 0008 renamed the column, which preserved every style but left the *rendering*
-- half of the old `visual_guidance` sitting in `scene_guidance` — so an
-- already-installed database has grade and lighting language in the field that
-- is now supposed to hold only settings and props, and an empty
-- `render_guidance` on the image style that should carry it.
--
-- Only the built-ins can be split mechanically: their text is known. A
-- user-authored style keeps its prose in `scene_guidance` untouched, which
-- degrades to today's behaviour rather than to a wrong one — the rendering
-- section simply stays empty until someone edits the style. Rewriting someone
-- else's art direction by pattern-match would be worse than leaving it.
UPDATE `narrative_styles` SET `scene_guidance` =
  'Institutional interiors, paperwork, surveillance angles, plain functional surfaces. Evidence rooms, records offices, car parks, front doors.'
  WHERE `is_builtin` = 1 AND `name` = 'Crime Documentary';--> statement-breakpoint
UPDATE `narrative_styles` SET `scene_guidance` =
  'Working environments and civic spaces — workshops, municipal halls, streets, meeting rooms. Faces and hands doing real work. Tools, benches, paperwork handled rather than filed.'
  WHERE `is_builtin` = 1 AND `name` = 'Underdog Rise';--> statement-breakpoint
UPDATE `narrative_styles` SET `scene_guidance` =
  'Domestic and ordinary settings made uneasy by framing and empty space — kitchens, hallways, parked cars, desks at night. Reflections, doorways, the room after someone has left it.'
  WHERE `is_builtin` = 1 AND `name` = 'Cautionary Tale';--> statement-breakpoint
UPDATE `image_styles` SET
  `render_guidance` = 'Photographic. Available light, desaturated colour, hard shadows, handheld framing. Natural skin texture and ordinary imperfection. Reads as a frame of documentary footage.',
  `negative_prompt` = 'illustration, cartoon, painting, cgi, oversaturated, glossy, text, watermark'
  WHERE `is_builtin` = 1 AND `name` = 'Documentary Realism';--> statement-breakpoint
UPDATE `image_styles` SET
  `render_guidance` = 'Composed like a film still. High contrast, hard directional light, deep shadow, cool colour grade. Faces partly in shadow. Deliberate, held framing rather than observed.',
  `negative_prompt` = 'illustration, cartoon, painting, cgi, flat lighting, low contrast, text, watermark'
  WHERE `is_builtin` = 1 AND `name` = 'Cinematic Noir';
