/**
 * The Development chain's stages, in order, with their display labels.
 *
 * A hand-kept mirror of `DEV_CHAIN_STAGES` in lib/db/schema.ts — hand-kept for
 * the same reason `PROJECT_FORMATS` is duplicated in new-project-form.tsx and
 * `REDO_CHAIN` in redo-warning.ts: schema.ts pulls in better-sqlite3 and is not
 * safe in a client bundle.
 *
 * Its own module rather than a constant inside `dev-chain-card.tsx`, so a test
 * can assert the mirror stays in step without dragging React into its import
 * graph — exactly the shape `redo-warning.ts` already has.
 *
 * **Order matters here, not just membership.** `DEV_CHAIN_ORDER` is derived
 * from this object's key order and is what the history panel renders in. M7.1
 * PR-A moved casting from stage 20 to stage 16 and this list did not follow, so
 * a finished project listed its work in a sequence it had not happened in —
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
