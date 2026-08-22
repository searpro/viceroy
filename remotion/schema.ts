import { z } from "zod";

export const captionStyleSchema = z.object({
  fontFamily: z.string().default("Inter, system-ui, -apple-system, sans-serif"),
  fontSize: z.number().default(76),
  fontWeight: z.number().default(800),
  color: z.string().default("#ffffff"),
  /** Drawn behind the text; a caption over a bright frame is unreadable without it. */
  outlineColor: z.string().default("#000000"),
  outlineWidth: z.number().default(10),
  /** Distance from the bottom edge, as a fraction of height. */
  bottomOffset: z.number().default(0.17),
  uppercase: z.boolean().default(false),
});

export type CaptionStyle = z.infer<typeof captionStyleSchema>;

export const storyVideoSchema = z.object({
  /** Filenames inside the staging directory Remotion is bundled against. */
  audioSrc: z.string(),
  scenes: z.array(
    z.object({
      src: z.string(),
      startMs: z.number(),
      endMs: z.number(),
    }),
  ),
  cues: z.array(
    z.object({
      text: z.string(),
      startMs: z.number(),
      endMs: z.number(),
    }),
  ),
  durationMs: z.number(),
  captionStyle: captionStyleSchema,
  // Read by Root.tsx's calculateMetadata to override the composition's
  // declared dimensions per render — a static <Composition width height>
  // cannot vary per project on its own. See F4: only the *source* image
  // dimensions are constrained to multiples of 16; the final render target
  // has no such requirement.
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type StoryVideoProps = z.infer<typeof storyVideoSchema>;

export const DEFAULT_CAPTION_STYLE: CaptionStyle = captionStyleSchema.parse({});

// M7 PR11 — Preproduction's own previs animatic. Deliberately much simpler
// than `storyVideoSchema` above: no audio track, no caption cues — a
// Preproduction-only project has neither a voiceover nor word-timed
// subtitles yet (previs runs off `shot_list_items`, well before either
// exists). `fps` is carried as its own prop, not inferred from the
// composition's own declared frame rate, because `runPrevis` computes each
// shot's `durationInFrames` from `durationHintMs` the same way this schema's
// consumer (`Previs.tsx`) does — the two need to agree on one fps, and
// passing it explicitly is cheaper than keeping a second constant in sync.
export const previsSchema = z.object({
  shots: z.array(
    z.object({
      /** Filename inside the staging directory Remotion is bundled against. */
      src: z.string(),
      durationMs: z.number().positive(),
    }),
  ),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
});

export type PrevisProps = z.infer<typeof previsSchema>;
