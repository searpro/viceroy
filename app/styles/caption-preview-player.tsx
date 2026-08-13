"use client";

import { Player } from "@remotion/player";
import { CaptionPreview } from "../../remotion/CaptionPreview";
import type { CaptionStyle } from "../../remotion/schema";

const FPS = 30;
const LOOP_MS = 6400;

/**
 * Live preview for the caption style editor.
 *
 * `@remotion/player` renders the composition directly as a React component
 * in the browser — no bundling, no staged files, no headless browser. That
 * is what makes it usable while a style is still being typed into, unlike
 * the render pipeline's `@remotion/renderer` path, which exists to produce
 * a real MP4 and costs minutes accordingly.
 */
export function CaptionPreviewPlayer({ captionStyle }: { captionStyle: CaptionStyle }) {
  return (
    <Player
      component={CaptionPreview}
      inputProps={{ captionStyle }}
      durationInFrames={Math.ceil((LOOP_MS / 1000) * FPS)}
      fps={FPS}
      compositionWidth={1080}
      compositionHeight={1920}
      style={{ width: "100%", aspectRatio: "9 / 16", borderRadius: 8, overflow: "hidden" }}
      loop
      autoPlay
      controls={false}
    />
  );
}
