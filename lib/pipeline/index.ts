import type { JobType } from "../db/schema";
import { runStory, runStoryEval, runStoryRevise, runSynopsis } from "./story";
import { runElements } from "./elements";
import { runCharacterImages, runSceneImages } from "./images";
import { runSubtitleAlign, runVoiceover } from "./voiceover";
import type { StageHandler } from "./context";

export * from "./context";
export * from "./segment";
export * from "./align";

/**
 * Job type to stage handler.
 *
 * Types with no entry yet are not silently skipped — the worker refuses them,
 * so a half-built pipeline can't advance a project past a stage that never
 * ran. PR5 fills in render.
 */
export const STAGE_HANDLERS: Partial<Record<JobType, StageHandler>> = {
  synopsis: runSynopsis,
  story: runStory,
  story_eval: runStoryEval,
  story_revise: runStoryRevise,
  elements: runElements,
  character_images: runCharacterImages,
  scene_images: runSceneImages,
  voiceover: runVoiceover,
  subtitle_align: runSubtitleAlign,
};
