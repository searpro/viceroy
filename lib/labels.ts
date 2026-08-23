/**
 * Display names for the vocabularies the UI shows: project formats, pipeline
 * job types, and Development-chain stages.
 *
 * One module because the same three vocabularies were being spelled out
 * separately in five screens, and they had already drifted: the jobs screen
 * printed the raw `story_eval`/`script_breakdown` keys, the "next" banner
 * printed `production_design` in a monospace font, and `dev-stages.ts` had a
 * label table only the project page could see. A user reading the jobs list
 * had no way to tell which of 32 job types belonged to the movie they were
 * making.
 *
 * **Client-safe.** No `lib/db/schema.ts` import — that pulls in better-sqlite3
 * and cannot be bundled — so the stage list here is a hand-kept mirror of
 * `DEV_CHAIN_STAGES`, guarded by `dev-stages.test.ts` exactly as it was before
 * this module existed.
 */

export const PROJECT_FORMATS: { value: string; label: string; short: string }[] = [
  { value: "short_video_narrative", label: "Short video (narrative slideshow)", short: "Short video" },
  { value: "short_movie", label: "Short movie", short: "Short movie" },
  { value: "short_film", label: "Short film", short: "Short film" },
  { value: "short_series", label: "Short series", short: "Short series" },
  { value: "series", label: "Series", short: "Series" },
  { value: "feature_film", label: "Feature film", short: "Feature film" },
];

export function formatLabel(format: string, short = false): string {
  const found = PROJECT_FORMATS.find((entry) => entry.value === format);
  if (!found) return format;
  return short ? found.short : found.label;
}

/** Whether a format runs the Development chain rather than the narrative pipeline. */
export function isDevFormat(format: string): boolean {
  return format !== "short_video_narrative";
}

/**
 * The Development chain's stages, in order, with their display labels.
 *
 * **Order matters here, not just membership.** `DEV_CHAIN_ORDER` is derived
 * from this object's key order and is what the review UI renders in. M7.1 PR-A
 * moved casting from stage 20 to stage 16 and this list did not follow, so a
 * finished project listed its work in a sequence it had not happened in —
 * caught by looking at the page, not by a test. `dev-stages.test.ts` is that
 * missing test.
 */
export const DEV_STAGE_LABELS: Record<string, string> = {
  concept: "Concept",
  logline: "Logline",
  characters: "Characters & arcs",
  world_building: "World building",
  story_structure: "Story structure",
  beat_sheet: "Beat sheet",
  treatment: "Treatment",
  screenplay: "Screenplay",
  screenplay_revision: "Screenplay revision",
  story_bible: "Story bible",
  script_breakdown: "Script breakdown",
  scene_breakdown: "Scene breakdown",
  continuity: "Continuity",
  visual_bible: "Visual bible",
  production_design: "Production design",
  // Casting sits above the image stages as of M7.1 PR-A — identity is locked
  // before anything draws it.
  casting: "Casting",
  concept_art: "Concept art",
  storyboards: "Storyboards",
  shot_list: "Shot list",
  previs: "Previs",
  production_plan: "Production plan",
  // Stage 22 (M7.2) — the handoff artifact between Preproduction and
  // Production. "Production timeline", not "Timeline": `remotion/timeline.ts`
  // means caption cues, and the two get confused in conversation.
  timeline: "Production timeline",
};

export const DEV_CHAIN_ORDER = Object.keys(DEV_STAGE_LABELS);

/**
 * The three acts of the Development chain, for grouping a 22-stage list into
 * something a person can navigate. Boundaries follow the M7 detail page's own
 * Development/Preproduction split, with the image-producing stages called out
 * separately because they are the slow, expensive, visually-reviewed ones.
 */
export const DEV_STAGE_PHASES: { key: string; label: string; stages: string[] }[] = [
  {
    key: "development",
    label: "Development",
    stages: [
      "concept",
      "logline",
      "characters",
      "world_building",
      "story_structure",
      "beat_sheet",
      "treatment",
      "screenplay",
      "screenplay_revision",
      "story_bible",
    ],
  },
  {
    key: "breakdown",
    label: "Breakdown",
    stages: ["script_breakdown", "scene_breakdown", "continuity", "visual_bible", "production_design"],
  },
  {
    key: "visuals",
    label: "Visuals",
    stages: ["casting", "concept_art", "storyboards", "shot_list", "previs"],
  },
  { key: "handoff", label: "Handoff", stages: ["production_plan", "timeline"] },
];

export function devStagePhase(stage: string): string | undefined {
  return DEV_STAGE_PHASES.find((phase) => phase.stages.includes(stage))?.label;
}

/** The narrative pipeline's own job types — everything not in the dev chain. */
const NARRATIVE_JOB_LABELS: Record<string, string> = {
  synopsis: "Synopsis",
  story: "Story",
  story_eval: "Story review",
  story_revise: "Story revision",
  elements: "Scenes & cast",
  character_images: "Character portraits",
  scene_images: "Scene images",
  voiceover: "Voiceover",
  subtitle_align: "Caption alignment",
  render: "Render",
};

/**
 * A job's display name.
 *
 * `jobs.type` spans both vocabularies — the Development chain's stages are
 * `JOB_TYPES` entries too, so one worker mechanism serves both — which is why
 * this falls through to the stage labels rather than having two lookups at
 * every call site.
 */
export function jobTypeLabel(type: string): string {
  return NARRATIVE_JOB_LABELS[type] ?? DEV_STAGE_LABELS[type] ?? type;
}

/** Which pipeline a job type belongs to, for grouping and filtering. */
export function jobTypeFlow(type: string): "narrative" | "development" {
  return NARRATIVE_JOB_LABELS[type] ? "narrative" : "development";
}

/**
 * What comes next, said in words.
 *
 * Both `nextStep.type` (a job type) and `nextStep.stage` (a dev-chain stage)
 * name it, and the banner printed whichever was set as a raw monospace key.
 */
export function nextStepLabel(nextStep: { kind: string; type?: string; stage?: string }): string {
  const key = nextStep.kind === "run" ? nextStep.type : nextStep.stage;
  return key ? jobTypeLabel(key) : "Done";
}
