import type { JobType } from "../db/schema";
import { runStory, runStoryEval, runStoryRevise, runSynopsis } from "./story";
import { runElements } from "./elements";
import { runCharacterImages, runSceneImages } from "./images";
import { runSubtitleAlign, runVoiceover } from "./voiceover";
import { runRender } from "./render";
import { runPrevis } from "./previs";
import { runTimeline } from "./timeline-stage";
import {
  runBeatSheet,
  runCasting,
  runConcept,
  runConceptArt,
  runContinuity,
  runDevCharacters,
  runLogline,
  runProductionDesign,
  runProductionPlan,
  runSceneBreakdown,
  runScreenplay,
  runScreenplayRevision,
  runScriptBreakdown,
  runShotList,
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
  // Preproduction (M7 PR6-PR13) — the full 11-stage 11-21 range, closing out
  // the milestone. Stages 1-10 (above) are Development.
  script_breakdown: runScriptBreakdown,
  scene_breakdown: runSceneBreakdown,
  continuity: runContinuity,
  visual_bible: runVisualBible,
  production_design: runProductionDesign,
  concept_art: runConceptArt,
  storyboards: runStoryboards,
  // Preproduction (M7 PR11) — stages 18-19.
  shot_list: runShotList,
  previs: runPrevis,
  // Preproduction (M7 PR12) — stage 20, the second-to-last of the 11-21
  // range this milestone's own PR sequence scoped for Preproduction.
  casting: runCasting,
  // Preproduction (M7 PR13) — stage 21, the capstone that closes out the
  // full 11-21 range and, with it, M7 itself.
  production_plan: runProductionPlan,
  // Stage 22 (M7.2) — the production timeline, the handoff artifact M8
  // consumes. Like `production_plan`, an assembly: it resolves no provider.
  timeline: runTimeline,
};
