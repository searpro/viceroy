import { AbsoluteFill, Img, Sequence, staticFile } from "remotion";
import type { PrevisProps } from "./schema";

/**
 * Preproduction's own thin animatic (M7 PR11, stage 19) — sequences each
 * approved shot list item's keyframe image for its own `durationHintMs`, no
 * audio, no captions.
 *
 * Deliberately not `StoryVideo`: that composition assumes a continuous
 * narration track and word-timed subtitle cues, neither of which exist for a
 * Preproduction-only project (previs runs off `shot_list_items`, well before
 * a project has a voiceover). Frames don't crossfade or zoom the way
 * `StoryVideo`'s scenes do either — this is a cut-only planning animatic, not
 * a polished render; `runPrevis` (lib/pipeline/previs.ts) is explicitly
 * scoped to not need any LTX/video-provider work, and a still image held for
 * its planned duration is what "silent animatic" (this PR's acceptance bar)
 * actually asks for.
 */
export function Previs({ shots, fps }: PrevisProps) {
  let startFrame = 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      {shots.map((shot, i) => {
        const durationInFrames = Math.max(1, Math.round((shot.durationMs / 1000) * fps));
        const from = startFrame;
        startFrame += durationInFrames;

        return (
          <Sequence key={`${shot.src}-${i}`} from={from} durationInFrames={durationInFrames}>
            <AbsoluteFill>
              <Img
                src={staticFile(shot.src)}
                style={{ width: "100%", height: "100%", objectFit: "cover" }}
              />
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
