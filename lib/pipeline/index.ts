import type { JobType } from "../db/schema";
import { runStory, runStoryEval, runStoryRevise, runSynopsis } from "./story";
import type { StageHandler } from "./context";

export * from "./context";

/**
 * Job type to stage handler.
 *
 * Types with no entry yet are not silently skipped — the worker refuses them,
 * so a half-built pipeline can't advance a project past a stage that never
 * ran. PR3-PR5 fill the remaining entries.
 */
export const STAGE_HANDLERS: Partial<Record<JobType, StageHandler>> = {
  synopsis: runSynopsis,
  story: runStory,
  story_eval: runStoryEval,
  story_revise: runStoryRevise,
};
