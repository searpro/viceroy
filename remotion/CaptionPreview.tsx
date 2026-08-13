import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { Caption } from "./StoryVideo";
import { activeCueAt, type TimelineCue } from "./timeline";
import type { CaptionStyle } from "./schema";

/**
 * A few sample lines, cycling on a loop — enough to see how a style reads
 * both in a short burst and in a longer one, without needing a real
 * project's scenes or narration staged anywhere.
 */
const SAMPLE_CUES: TimelineCue[] = [
  { text: "A plumber became mayor by wits alone.", startMs: 0, endMs: 2200 },
  { text: "Nobody believed he could win the vote.", startMs: 2200, endMs: 4200 },
  { text: "THEN THE RECOUNT CHANGED EVERYTHING", startMs: 4200, endMs: 6400 },
];
const LOOP_MS = SAMPLE_CUES[SAMPLE_CUES.length - 1]!.endMs;

/**
 * Caption rendering only, over a placeholder gradient rather than a staged
 * photo — the point is to see the text style, not stand in for a real frame.
 * Driven directly by `@remotion/player` in the browser, no bundling or
 * staged files required, which is what makes this usable as a live preview
 * while a style is still being edited.
 */
export function CaptionPreview({ captionStyle }: { captionStyle: CaptionStyle }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const nowMs = ((frame / fps) * 1000) % LOOP_MS;
  const cue = activeCueAt(nowMs, SAMPLE_CUES);

  return (
    <AbsoluteFill style={{ background: "linear-gradient(135deg, #3a3a46, #131318)" }}>
      {cue && <Caption text={cue.text} style={captionStyle} />}
    </AbsoluteFill>
  );
}
