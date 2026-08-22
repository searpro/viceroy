import type { JobType } from "../db/schema";
import { runStory, runStoryEval, runStoryRevise, runSynopsis } from "./story";
import { runElements } from "./elements";
import { runCharacterImages, runSceneImages } from "./images";
import { runSubtitleAlign, runVoiceover } from "./voiceover";
import { runRender } from "./render";
import {
  runBeatSheet,
  runConcept,
  runConceptArt,
  runContinuity,
  runDevCharacters,
  runLogline,
  runProductionDesign,
  runSceneBreakdown,
  runScreenplay,
  runScreenplayRevision,
  runScriptBreakdown,
  runStoryBible,
  runStoryboards,
  runStoryStructure,
  runTreatment,
  runVisualBible,
  runWorldBuilding,
} from "./dev";
import type { StageHandler } from "./context";

export * from "./context";
export * from "./segment";
export * from "./align";

/**
 * Job type to stage handler.
 *
 * Types with no entry yet are not silently skipped — the worker refuses them,
 * so a half-built pipeline can't advance a project past a stage that never
 * ran.
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
  render: runRender,
  // Development chain (M7 PR2-PR5) — the full ten-stage chain, per
  // `DEV_CHAIN_STAGES` in lib/db/schema.ts.
  concept: runConcept,
  logline: runLogline,
  characters: runDevCharacters,
  world_building: runWorldBuilding,
  story_structure: runStoryStructure,
  beat_sheet: runBeatSheet,
  treatment: runTreatment,
  screenplay: runScreenplay,
  screenplay_revision: runScreenplayRevision,
  story_bible: runStoryBible,
  // Preproduction (M7 PR6-PR10) — stages 11-17 of the full 11-21 range. Stage
  // 18+ has no entry yet; the worker refuses those job types the same way it
  // refuses any other unimplemented one, until a later PR adds them.
  script_breakdown: runScriptBreakdown,
  scene_breakdown: runSceneBreakdown,
  continuity: runContinuity,
  visual_bible: runVisualBible,
  production_design: runProductionDesign,
  concept_art: runConceptArt,
  storyboards: runStoryboards,
};
