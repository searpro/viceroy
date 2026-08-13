import { Composition } from "remotion";
import { StoryVideo } from "./StoryVideo";
import { storyVideoSchema, DEFAULT_CAPTION_STYLE, type StoryVideoProps } from "./schema";

export const STORY_COMPOSITION_ID = "StoryVideo";
export const FPS = 30;

/**
 * Placeholder props so the composition can be selected and previewed without a
 * project. The real ones are injected per render.
 */
const PLACEHOLDER: StoryVideoProps = {
  audioSrc: "narration.wav",
  scenes: [],
  cues: [],
  durationMs: 1000,
  captionStyle: DEFAULT_CAPTION_STYLE,
  width: 1080,
  height: 1920,
};

export function RemotionRoot() {
  return (
    <Composition
      id={STORY_COMPOSITION_ID}
      component={StoryVideo}
      schema={storyVideoSchema}
      defaultProps={PLACEHOLDER}
      fps={FPS}
      width={PLACEHOLDER.width}
      height={PLACEHOLDER.height}
      durationInFrames={FPS}
      // Length follows the narration: the audio is the master clock, and a
      // composition shorter than it would cut the story off mid-sentence.
      // Width/height follow the project's chosen resolution — a static
      // width/height prop above can only cover the placeholder case.
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(1, Math.ceil((props.durationMs / 1000) * FPS)),
        width: props.width,
        height: props.height,
      })}
    />
  );
}
