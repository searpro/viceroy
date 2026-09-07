import { Composition } from "remotion";
import { StoryVideo } from "./StoryVideo";
import { Previs } from "./Previs";
import { storyVideoSchema, previsSchema, DEFAULT_CAPTION_STYLE, type StoryVideoProps, type PrevisProps } from "./schema";

export const STORY_COMPOSITION_ID = "StoryVideo";
export const PREVIS_COMPOSITION_ID = "Previs";
export const FPS = 30;

/**
 * Placeholder props so the composition can be selected and previewed without a
 * project. The real ones are injected per render.
 */
const PLACEHOLDER: StoryVideoProps = {
  audioSrc: "narration.wav",
  shots: [],
  cues: [],
  durationMs: 1000,
  captionStyle: DEFAULT_CAPTION_STYLE,
  width: 1080,
  height: 1920,
};

// M7 PR11's own placeholder, same reasoning as `PLACEHOLDER` above.
const PREVIS_PLACEHOLDER: PrevisProps = {
  shots: [],
  width: 1080,
  height: 1920,
  fps: FPS,
};

export function RemotionRoot() {
  return (
    <>
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
      <Composition
        id={PREVIS_COMPOSITION_ID}
        component={Previs}
        schema={previsSchema}
        defaultProps={PREVIS_PLACEHOLDER}
        fps={FPS}
        width={PREVIS_PLACEHOLDER.width}
        height={PREVIS_PLACEHOLDER.height}
        durationInFrames={FPS}
        // Length follows the sum of every shot's own duration hint, the same
        // "the composition's declared length is only ever a placeholder"
        // reasoning `STORY_COMPOSITION_ID` above already applies.
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            props.shots.reduce(
              (total, shot) => total + Math.max(1, Math.round((shot.durationMs / 1000) * props.fps)),
              0,
            ),
          ),
          width: props.width,
          height: props.height,
        })}
      />
    </>
  );
}
