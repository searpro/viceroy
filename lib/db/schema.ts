import { sqliteTable, text, integer, real, index, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

/* ------------------------------------------------------------------ styles */

// The evaluation checklist is a closed vocabulary *per narrative style*, not
// one global enum: a gentle ending is a flaw in a thriller and the goal in a
// bedtime story, so no single list can be right for both. The evaluator is
// rejected if it names a key outside its own style's checklist.
export const narrativeStyles = sqliteTable("narrative_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  plannerGuidance: text("planner_guidance").notNull(),
  writingGuidance: text("writing_guidance").notNull(),
  // What the world of this story looks like: settings, props, subjects,
  // framing. Deliberately NOT how it is rendered — grade, film stock and
  // lighting quality live on the image style's `renderGuidance`, because they
  // apply to character portraits too and this does not. Conflating the two is
  // what let a portrait be generated in a different register from the scenes
  // that use it as a reference (BUG-009).
  sceneGuidance: text("scene_guidance").notNull(),
  evaluationChecklist: text("evaluation_checklist", { mode: "json" })
    .notNull()
    .$type<{ key: string; description: string }[]>(),
  targetSceneCount: integer("target_scene_count").notNull().default(8),
  targetWordCount: integer("target_word_count").notNull().default(320),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// A style is guidance, not configuration: which model runs it and what knobs
// it's called with belong to the provider (see `providers` below), so the
// same style produces consistent results however many providers of that kind
// exist and reads the same regardless of which one is active.
export const voiceStyles = sqliteTable("voice_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  // Sent verbatim as `instruct` to the voice-design model, and ONLY via
  // POST /v1/audio/tasks/run — /v1/audio/speech accepts this field, forwards
  // it, and silently ignores it. See docs/findings.md F2.
  ttsInstruct: text("tts_instruct").notNull(),
  // Delivery guidance handed to the writer so the script it produces suits
  // the voice that will read it.
  deliveryCues: text("delivery_cues").notNull(),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const imageStyles = sqliteTable("image_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  // The rendering register in prose, written to be read by the LLM that
  // composes an image prompt. `promptPrefix`/`promptSuffix` are the mechanical
  // wrapper applied afterwards; this is what stops the model writing a prompt
  // that argues with that wrapper (BUG-008).
  renderGuidance: text("render_guidance").notNull().default(""),
  promptPrefix: text("prompt_prefix").notNull().default(""),
  promptSuffix: text("prompt_suffix").notNull().default(""),
  // Overrides the image provider's negative prompt when set. Moving negatives
  // onto the provider (commit c19bbbe) merged two styles' avoid-lists into
  // one, leaving documentary generations arguing against their own available
  // light (BUG-014). A style may now carry its own; empty means "use the
  // provider's".
  negativePrompt: text("negative_prompt").notNull().default(""),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Mirrors remotion/schema.ts's captionStyleSchema field-for-field — that file
// is what the render pipeline and the live preview actually validate props
// against, so a field added there needs the same field added here to reach a
// render at all.
export const captionStyles = sqliteTable("caption_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  fontFamily: text("font_family").notNull().default("Inter, system-ui, -apple-system, sans-serif"),
  fontSize: integer("font_size").notNull().default(76),
  fontWeight: integer("font_weight").notNull().default(800),
  color: text("color").notNull().default("#ffffff"),
  outlineColor: text("outline_color").notNull().default("#000000"),
  outlineWidth: integer("outline_width").notNull().default(10),
  bottomOffset: real("bottom_offset").notNull().default(0.17),
  uppercase: integer("uppercase", { mode: "boolean" }).notNull().default(false),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// M7 PR2. Feeds the *text* register of the Development chain's prompts only
// (concept, logline, characters+arcs, world building, story structure) —
// genre/tone/pacing guidance for the writer. Deliberately not a second owner
// of the rendering register `imageStyles.renderGuidance` already owns: ADR
// 0002 and the Prompt & Flow Audit both name mixing narrative-register and
// rendering-register guidance across two style types as the root cause behind
// 15 bug entries (visualGuidance vs promptPrefix). A Direction Style's fields
// must never be threaded into an image-generation prompt path.
export const directionStyles = sqliteTable("direction_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  genreGuidance: text("genre_guidance").notNull(),
  toneGuidance: text("tone_guidance").notNull(),
  pacingGuidance: text("pacing_guidance").notNull(),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// M7 PR6. Production Design Style's own register — Preproduction's
// aesthetic/production-design text guidance, exact same shape as Direction
// Style but for a different concern (ADR 0002 again: a style type's fields
// belong to one register only). Nothing consumes this yet in PR6 — the
// production-design text stage that reads it is PR8's scope — but the table
// and CRUD are built now because they're foundational, the same way
// Direction Style's own table shipped a PR ahead of anything reading it.
export const productionDesignStyles = sqliteTable("production_design_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  // Overall aesthetic approach: naturalistic vs. heightened, practical vs.
  // stylised.
  visualLanguageGuidance: text("visual_language_guidance").notNull(),
  // Colour/lighting philosophy — deliberately not `renderGuidance`'s job
  // (that's Image Style's rendering register); this is the production
  // department's intent, for a later text prompt to translate.
  paletteGuidance: text("palette_guidance").notNull(),
  // Materials/texture/period-detail approach.
  textureGuidance: text("texture_guidance").notNull(),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ----------------------------------------------------------------- project */

export const PROJECT_STAGES = [
  "draft",
  "synopsis",
  "story",
  "story_eval",
  "elements",
  "character_images",
  "scene_images",
  "voiceover",
  "subtitle_align",
  "render",
  "complete",
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

// What kind of thing a project is making. `short_video_narrative` is today's
// only format and the whole of the pipeline above — idea, synopsis, story,
// scenes, one continuous voiceover, captions, a vertical render — is built
// for it alone. Every other value routes through the Development +
// Preproduction chain (M7) instead; see `DEV_ARTIFACT_STAGES` and
// `devNextStep` in `lib/pipeline/chain.ts`.
export const PROJECT_FORMATS = [
  "short_video_narrative",
  "short_movie",
  "short_film",
  "short_series",
  "series",
  "feature_film",
] as const;
export type ProjectFormat = (typeof PROJECT_FORMATS)[number];

export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    idea: text("idea").notNull(),
    title: text("title"),
    // How the story's facts originate: "idea" is today's freely-invented
    // one-liner; "context" grounds every downstream stage in a longer,
    // user-supplied source text (see `context`). Deliberately not named
    // `mode` — that already means the auto/manual *review* cadence below.
    inputMode: text("input_mode", { enum: ["idea", "context"] }).notNull().default("idea"),
    // Populated only when inputMode === "context". Only the synopsis stage
    // reads this directly; every later stage works from the synopsis/story
    // text it produced, so the context's token cost is paid once.
    context: text("context"),
    synopsis: text("synopsis"),
    story: text("story"),
    stage: text("stage", { enum: PROJECT_STAGES }).notNull().default("draft"),
    // Defaulted to today's only format so every project that predates M7 keeps
    // running the narrative pipeline exactly as it always has.
    format: text("format", { enum: PROJECT_FORMATS }).notNull().default("short_video_narrative"),
    mode: text("mode", { enum: ["auto", "manual"] }).notNull().default("auto"),
    // Set when a stage finished and is waiting on the user in manual mode.
    awaitingReview: integer("awaiting_review", { mode: "boolean" }).notNull().default(false),
    failureReason: text("failure_reason"),

    narrativeStyleId: text("narrative_style_id").references(() => narrativeStyles.id),
    voiceStyleId: text("voice_style_id").references(() => voiceStyles.id),
    imageStyleId: text("image_style_id").references(() => imageStyles.id),
    captionStyleId: text("caption_style_id").references(() => captionStyles.id),
    // Only meaningful for a Development-chain project (M7 PR2); the narrative
    // pipeline never reads this. Nullable like the other three styles were
    // before this column existed — a project created before Direction Style
    // shipped has no way to have one set.
    directionStyleId: text("direction_style_id").references(() => directionStyles.id),
    // M7 PR6. Same "only a Development-chain project resolves one" story as
    // `directionStyleId` above — nullable for the same reason (predates this
    // column), and unread by anything until PR8's production-design text
    // stage exists to consume it.
    productionDesignStyleId: text("production_design_style_id").references(
      () => productionDesignStyles.id,
    ),
    // The "characters+arcs" dev-chain stage writes/extends `characters` rows
    // directly rather than a `dev_artifacts` row (see `DEV_CHAIN_STAGES`), so
    // it has no artifact row of its own to carry an `approvedAt`. This is
    // that stage's equivalent gate, read by `devNextStep`.
    charactersApprovedAt: integer("characters_approved_at", { mode: "timestamp_ms" }),
    // The "characters+arcs" stage's equivalent of `dev_artifacts.directionHistory`
    // — there is no single row of its own for a whole-cast redo to attach to.
    charactersDirectionHistory: text("characters_direction_history", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default([]),
    // M7 PR7. The "continuity" stage's equivalent of `charactersApprovedAt`
    // above — it writes many `continuity_facts` rows, not one row of its own,
    // so it has nowhere else to record approval. Deliberately NOT gated on
    // every extracted fact being resolved: the spec's own scope for PR7 is "no
    // UI review surface beyond a flat list", so approval here means only "the
    // extraction ran and a human clicked continue", the same bar `characters`
    // and `world_building` clear — see `devStageStatus` in chain.ts.
    continuityApprovedAt: integer("continuity_approved_at", { mode: "timestamp_ms" }),
    // M7 PR9. The "concept_art" stage's equivalent of `charactersApprovedAt`/
    // `continuityApprovedAt` above — it writes to `locations.imageAssetId`/
    // `props.imageAssetId`, not a row of its own, so it has nowhere else to
    // record approval. Set once the generation pass completes (auto mode) or
    // once a human clicks continue past it (manual mode) — not gated on
    // per-image review, since there is no review UI for individual concept
    // art yet, the same bar `continuity`'s own approval clears.
    conceptArtApprovedAt: integer("concept_art_approved_at", { mode: "timestamp_ms" }),
    // Nullable, like captionStyleId: a project created before this column
    // existed has no way to have one set. render.ts falls back to
    // config.video's dimensions when either is null.
    width: integer("width"),
    height: integer("height"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_stage_idx").on(t.stage)],
);

export const characters = sqliteTable(
  "characters",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    // A short, purely visual descriptor ("wiry man in his fifties, close-cropped
    // grey hair, navy work overalls") injected into every scene prompt this
    // character appears in. With no edit-capable image model installed,
    // `ref_images` cannot enforce consistency, so a repeated canonical
    // description is what keeps a face recognisable between frames.
    appearanceTag: text("appearance_tag"),
    imagePrompt: text("image_prompt"),
    // sd-api's name for this character's uploaded reference portrait, passed
    // as `ref_images` on every scene they appear in. Points at state in
    // another service, so a dangling name must degrade to a text-only
    // generation rather than fail the stage. See docs/adr/0001.
    refInputName: text("ref_input_name"),
    // The reference portrait, generated before any scene so scene images can
    // pass it as ref_images and keep the character consistent between frames.
    imageAssetId: text("image_asset_id").references(() => assets.id),
    // Distinguishes a portrait the pipeline generated from one the user
    // uploaded (VIC-002): `imageAssetId`/`refInputName` are already
    // source-agnostic (a path and an sd-api name work identically either
    // way), but `character_images`' skip logic, the UI's "revert to
    // generated" affordance, and a future `elements` re-run all need to know
    // which one they're looking at without guessing from other fields.
    imageSource: text("image_source", { enum: ["generated", "uploaded"] })
      .notNull()
      .default("generated"),
    // M7 PR2. Written by the Development chain's "characters+arcs" stage —
    // where this character changes over the story, not who they are at the
    // start (that's `description`). Null for every character the narrative
    // pipeline's `elements` stage extracts, since that pipeline has no arc
    // concept and this column is nullable for exactly that reason.
    arc: text("arc"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("characters_project_idx").on(t.projectId)],
);

export const scenes = sqliteTable(
  "scenes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    description: text("description").notNull(),
    // Nullable because element extraction is resumable: scene rows are written
    // as soon as their narration span is known, then filled in one at a time.
    // A run that dies at scene 6 of 8 resumes rather than restarting.
    storyboard: text("storyboard"),
    imagePrompt: text("image_prompt"),
    // A verbatim span of the approved narration, never separately written text
    // — concatenating these must reproduce the story exactly, because the
    // voiceover is generated from the whole thing in one shot.
    voiceoverScript: text("voiceover_script").notNull(),
    voiceCues: text("voice_cues"),
    characterIds: text("character_ids", { mode: "json" }).notNull().$type<string[]>().default([]),
    imageAssetId: text("image_asset_id").references(() => assets.id),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),

    // Filled by subtitle alignment: where this scene's narration sits inside
    // the single continuous voiceover track. This is what maps one audio file
    // back onto N images.
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("scenes_project_index_uq").on(t.projectId, t.index)],
);

// Shared by the narrative pipeline's story_eval/story_revise loop (story.ts)
// and the Development chain's screenplay_revision loop (dev.ts, M7 PR5) —
// deliberately not split into two tables or given a "subject"/"kind"
// discriminator column. Nothing here names what was judged; every column is
// already generic (a checklist's keys, a verdict, freeform issue notes), and
// a project is only ever one format or the other (`projects.format`), so its
// evaluations rows are always all one loop's history or all the other's,
// never a mix one query could misattribute. Splitting would only add a
// column every reader has to thread through for a distinction the data never
// actually needs to make.
export const evaluations = sqliteTable(
  "evaluations",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    iteration: integer("iteration").notNull(),
    verdict: text("verdict", { enum: ["pass", "revise", "fail"] }).notNull(),
    overallScore: real("overall_score"),
    // Keyed by whichever checklist judged this evaluation — the narrative
    // style's own checklist for a story_eval row, or `SCREENPLAY_CHECKLIST`
    // (dev.ts) for a screenplay_revision row.
    dimensions: text("dimensions", { mode: "json" })
      .notNull()
      .$type<Record<string, { score: number; comment: string }>>(),
    issues: text("issues", { mode: "json" })
      .notNull()
      .$type<{ severity: "low" | "medium" | "high"; note: string; sceneIndex?: number }[]>(),
    model: text("model").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("evaluations_project_idx").on(t.projectId)],
);

export const voiceovers = sqliteTable("voiceovers", {
  id: id(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  // The whole story's narration, concatenated from every scene before a single
  // TTS call. Generating per scene and stitching produces audible voice drift.
  script: text("script").notNull(),
  ttsInstruct: text("tts_instruct").notNull(),
  audioAssetId: text("audio_asset_id").references(() => assets.id),
  durationMs: integer("duration_ms"),
  sampleRate: integer("sample_rate"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const subtitleCues = sqliteTable(
  "subtitle_cues",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: text("scene_id").references(() => scenes.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    // What the writer wrote. ASR is the source of TIMING only — its transcript
    // normalises "three seventeen" to "317" and straightens apostrophes, so
    // displaying it would ship the model's misreading. See findings F5.
    text: text("text").notNull(),
    // What ASR actually heard, kept for debugging the alignment.
    heardText: text("heard_text"),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("subtitle_cues_project_index_uq").on(t.projectId, t.index)],
);

export const renders = sqliteTable(
  "renders",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    fps: integer("fps").notNull().default(30),
    captionStyle: text("caption_style", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    assetId: text("asset_id").references(() => assets.id),
    status: text("status", { enum: ["pending", "rendering", "ready", "failed"] })
      .notNull()
      .default("pending"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("renders_project_idx").on(t.projectId)],
);

// The Development chain's own artifacts (M7). Deliberately not `scenes` or
// `characters` — those are the narrative pipeline's, and mixing the two
// would make a dev-format project's `elements` redo touch rows that mean
// something completely different in Preproduction. Characters and
// world-building get their own tables in a later PR, same reasoning as
// `scenes` already being separate from `characters` above.
export const DEV_ARTIFACT_STAGES = [
  "concept",
  "logline",
  "story_structure",
  "beat_sheet",
  "treatment",
  "screenplay",
  "screenplay_revision",
  "story_bible",
  // Preproduction (M7 PR6), stages 11-12. Development's capstone artifact
  // (story_bible) is what "script_breakdown" reads; "scene_breakdown" is a
  // finer-grained second pass over "script_breakdown" — see dev.ts for the
  // coarse/fine split each was scoped to.
  "script_breakdown",
  "scene_breakdown",
  // Preproduction (M7 PR8), stages 14-15. "visual_bible" is an assembly
  // stage, same shape as "story_bible" — it pulls Production Design Style's
  // guidance plus every approved location/prop and continuity fact into one
  // document, no LLM call. "production_design" is the first stage to
  // generate against it (see dev.ts's `runVisualBible`/`runProductionDesign`
  // for both). Neither needs its own table — like "story_bible", each is one
  // document per project.
  "visual_bible",
  "production_design",
] as const;
export type DevArtifactStage = (typeof DEV_ARTIFACT_STAGES)[number];

// The Development chain's full ordering (M7 PR2), all ten stages the Model
// strategy section of the M7 detail page counts. A superset of
// `DEV_ARTIFACT_STAGES` — "characters" and "world_building" (PR2) sit between
// "logline" and "story_structure" but write their own tables (`characters`,
// `world_building`/`locations`/`props`) rather than a `dev_artifacts` row, the
// same way the narrative pipeline's `elements` stage populates `scenes`/
// `characters` directly instead of some generic artifact table. `devNextStep`
// and `INVALIDATION_CHAIN` walk this list, not `DEV_ARTIFACT_STAGES` — that
// one still means exactly what PR1 defined it to mean: which stages own a
// `dev_artifacts` row.
export const DEV_CHAIN_STAGES = [
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
  // Preproduction begins here (M7 PR6) — the first two of stages 11-21, once
  // Development's "story_bible" is approved. `devNextStep` walks this array
  // in order, so Preproduction stages only ever become "next" after every
  // Development stage above them is approved.
  "script_breakdown",
  "scene_breakdown",
  // Stage 13 (M7 PR7) — extracted facts live in `continuity_facts`, not
  // `dev_artifacts` (see that table's own comment below), so like
  // "characters"/"world_building" this is a `DEV_TABLE_STAGES` entry, not a
  // `DEV_ARTIFACT_STAGES` one.
  "continuity",
  // Stages 14-15 (M7 PR8) — both `dev_artifacts` rows, per
  // `DEV_ARTIFACT_STAGES` above.
  "visual_bible",
  "production_design",
  // Stage 16 (M7 PR9) — the first stage in this whole chain that generates
  // images rather than text. Writes to `locations`/`props` directly, not a
  // `dev_artifacts` row (see `DEV_TABLE_STAGES` below) — same shape as
  // "characters"/"world_building"/"continuity" before it. Character
  // portraits are deliberately out of scope here (see `runConceptArt`'s own
  // comment in dev.ts) — the M7 detail page's stage list puts identity-lock
  // casting at stage 20, not here.
  "concept_art",
] as const;
export type DevChainStage = (typeof DEV_CHAIN_STAGES)[number];

// The dev-chain stages that are NOT `dev_artifacts` rows (see
// `DEV_CHAIN_STAGES` above) — pulled out as their own type so job dispatch and
// `DISCARD` can be exhaustive over them without re-deriving the split from
// `DEV_CHAIN_STAGES` minus `DEV_ARTIFACT_STAGES` by hand.
export const DEV_TABLE_STAGES = ["characters", "world_building", "continuity", "concept_art"] as const;
export type DevTableStage = (typeof DEV_TABLE_STAGES)[number];

export const devArtifacts = sqliteTable(
  "dev_artifacts",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    stage: text("stage", { enum: DEV_ARTIFACT_STAGES }).notNull(),
    // A stage can be redone more than once before it's approved; each redo is
    // a new version rather than an overwrite, so `directionHistory` has
    // something to record against.
    version: integer("version").notNull().default(1),
    content: text("content").notNull(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    // What the user asked for on each redo of this stage, oldest first. Kept
    // even when a redo clears `approvedAt`/`content` (see `DISCARD` in
    // lib/projects.ts) — the row survives so this history isn't lost with it.
    directionHistory: text("direction_history", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("dev_artifacts_project_idx").on(t.projectId),
    unique("dev_artifacts_project_stage_version_idx").on(t.projectId, t.stage, t.version),
  ],
);

// M7 PR2. One row per project — rules/tone/theme prose only, deliberately
// NOT locations or props (those get their own first-class tables below, the
// same reasoning that keeps `characters` separate from `scenes`). Approved
// the same way a `dev_artifacts` row is, even though it isn't one: the
// "world building" stage writes this row plus the `locations`/`props` rows it
// derived from the same generation in one step, so all three share this row's
// `approvedAt` as their one gate.
export const worldBuilding = sqliteTable(
  "world_building",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    content: text("content").notNull().default(""),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    directionHistory: text("direction_history", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // One row per project: unlike `dev_artifacts`, a redo overwrites this row in
  // place rather than versioning, since `locations`/`props` are foreign-keyed
  // to nothing more specific than the project and are cleared/recreated with
  // it (see `DISCARD` in lib/projects.ts) — there is no second version of a
  // world to keep alongside the first.
  (t) => [unique("world_building_project_idx").on(t.projectId)],
);

// Mirrors `characters`' visual-consistency columns exactly (name, description,
// imageAssetId, refInputName, imageSource) — see the M7 detail page. A
// dangling `refInputName` is handled by the same `filterLiveRefs` the
// narrative pipeline already uses for characters (lib/pipeline/images.ts),
// unchanged: degrade to text-only, log a warning, never fail the stage.
export const locations = sqliteTable(
  "locations",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    imageAssetId: text("image_asset_id").references(() => assets.id),
    refInputName: text("ref_input_name"),
    imageSource: text("image_source", { enum: ["generated", "uploaded"] })
      .notNull()
      .default("generated"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("locations_project_idx").on(t.projectId)],
);

// Same shape as `locations`, same reasoning — see there.
export const props = sqliteTable(
  "props",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    imageAssetId: text("image_asset_id").references(() => assets.id),
    refInputName: text("ref_input_name"),
    imageSource: text("image_source", { enum: ["generated", "uploaded"] })
      .notNull()
      .default("generated"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("props_project_idx").on(t.projectId)],
);

export const CONTINUITY_SUBJECT_TYPES = ["character", "location", "prop"] as const;
export type ContinuitySubjectType = (typeof CONTINUITY_SUBJECT_TYPES)[number];

export const CONTINUITY_FACT_SOURCES = ["extracted", "conflict", "resolved"] as const;
export type ContinuityFactSource = (typeof CONTINUITY_FACT_SOURCES)[number];

// Stage 13 (M7 PR7). Facts extracted from the Story Bible plus the script/
// scene breakdowns — a character's scar, where a prop was left, a location's
// established geography — surfaced for human review rather than silently
// trusted (the M7 detail page's own "never silent auto-resolution").
//
// `subjectId` deliberately carries no DB-level FK: the LLM names a subject by
// type (character/location/prop), and each type is its own table, so a real
// foreign key would need to point at three different tables depending on a
// sibling column's value. `scenes.characterIds` already accepts this same
// trade-off for a loose id list rather than a polymorphic FK — see its own
// comment. `subjectName` is kept alongside it, denormalized, purely so the
// flat review list (dev-chain-card.tsx) can render without a three-way join
// per row; `dev.ts`'s extraction handler is what keeps it in sync with the
// row it resolved the id from.
//
// `sceneId` is free text, not a `scenes` FK either — the dev chain's script/
// scene breakdowns are prose documents ("SCENE 3 — INT. ..."), not `scenes`
// rows (those are the narrative pipeline's own table, per `DEV_ARTIFACT_STAGES`'s
// comment above), so a fact anchored to one just carries whatever scene
// number/heading the LLM extracted it against.
//
// A conflicting fact is never overwritten in place: the new, conflicting
// fact is inserted as its own row with `source: "conflict"`, leaving the
// original untouched — see `runContinuity`'s doc comment for how a conflict
// is detected. Approving a conflict sets `resolvedAt` without deleting either
// row, the same audit-trail discipline `dev_artifacts.directionHistory`
// already keeps.
export const continuityFacts = sqliteTable(
  "continuity_facts",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: text("scene_id"),
    subjectType: text("subject_type", { enum: CONTINUITY_SUBJECT_TYPES }).notNull(),
    subjectId: text("subject_id").notNull(),
    subjectName: text("subject_name").notNull(),
    fact: text("fact").notNull(),
    source: text("source", { enum: CONTINUITY_FACT_SOURCES }).notNull().default("extracted"),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("continuity_facts_project_idx").on(t.projectId),
    index("continuity_facts_subject_idx").on(t.projectId, t.subjectId),
  ],
);

export const assets = sqliteTable("assets", {
  id: id(),
  kind: text("kind", { enum: ["image", "audio", "video"] }).notNull(),
  path: text("path").notNull(),
  mimeType: text("mime_type").notNull(),
  bytes: integer("bytes").notNull(),
  meta: text("meta", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------------ system */

export const JOB_TYPES = [
  "synopsis",
  "story",
  "story_eval",
  "story_revise",
  "elements",
  "character_images",
  "scene_images",
  "voiceover",
  "subtitle_align",
  "render",
  // The Development chain's stages are added here, not to a parallel
  // job-type list, so `regenerate()` can enqueue them through the one
  // generic mechanism every narrative stage already uses. `DEV_CHAIN_STAGES`
  // (M7 PR2) rather than `DEV_ARTIFACT_STAGES` (M7 PR1) — "characters" and
  // "world_building" need job types too, even though they aren't
  // `dev_artifacts` rows. screenplay onward still has no `STAGE_HANDLERS`
  // entry — PR4+ scope — so the worker refuses one if it is ever claimed, the
  // same way it refuses any other unimplemented type.
  ...DEV_CHAIN_STAGES,
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "aborted"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: id(),
    type: text("type", { enum: JOB_TYPES }).notNull(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    payload: text("payload", { mode: "json" }).notNull().$type<Record<string, unknown>>().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    error: text("error"),
    // Set by an abort request; the worker checks it between steps and on every
    // progress tick, since a running sd-api job can't be interrupted mid-call.
    abortRequested: integer("abort_requested", { mode: "boolean" }).notNull().default(false),
    // Opaque handle for the in-flight sd-api job, so an abort can cancel it
    // upstream rather than only locally.
    externalJobId: text("external_job_id"),
    runAfter: integer("run_after", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAfter),
    index("jobs_project_idx").on(t.projectId),
  ],
);

export const jobLogs = sqliteTable(
  "job_logs",
  {
    id: id(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    level: text("level", { enum: ["debug", "info", "warn", "error"] }).notNull().default("info"),
    message: text("message").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("job_logs_job_idx").on(t.jobId)],
);

export const providers = sqliteTable(
  "providers",
  {
    id: id(),
    kind: text("kind", { enum: ["llm", "image", "audio", "asr", "video"] }).notNull(),
    // Which protocol `baseUrl` speaks. Two hosts of the same kind are not
    // interchangeable — sd-api takes a request shaped like its own API, while
    // ComfyUI takes a whole workflow graph and has no notion of `model` at
    // all. Defaulted so every row that predates ComfyUI keeps working.
    adapter: text("adapter", { enum: ["sdapi", "comfyui"] })
      .notNull()
      .default("sdapi"),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key"),
    model: text("model").notNull(),
    defaultParams: text("default_params", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    // Diffusion-specific: what an image or video provider's generations
    // should avoid. Meaningless for kind "llm"/"audio"/"asr", where it stays "".
    negativePrompt: text("negative_prompt").notNull().default(""),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    // How to bring this provider's host up on demand, when it is a pod that
    // costs money to leave running. Null means "assume it is always there",
    // which is what every local install wants. Nothing reads this yet — the
    // column is here because migrations are append-only and adding it now is
    // free, whereas a second migration later is not.
    compute: text("compute", { mode: "json" }).$type<ProviderCompute | null>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("providers_kind_idx").on(t.kind)],
);

export type ProviderCompute = {
  kind: "runpod";
  podId: string;
  /**
   * The HTTP port RunPod's proxy fronts, 8188 for ComfyUI.
   *
   * Stored alongside the id because together they *are* the base URL —
   * `https://{podId}-{port}.proxy.runpod.net` — so a pod rebuilt under a new
   * id needs one field changed rather than a URL re-copied by hand.
   */
  port: number;
  /**
   * Minutes of idleness before the pod should be stopped. Nothing enforces
   * this yet; it is recorded so the policy lives with the pod it applies to
   * rather than in whatever later grows the timer.
   */
  idleStopMinutes?: number;
};

/**
 * What a workflow is *for*, in the pipeline's vocabulary rather than the
 * user's.
 *
 * A ComfyUI provider cannot be a single workflow, because one kind needs
 * several shapes of generation: a scene with characters in it has to be
 * generated against their reference portraits, and a scene with nobody in it
 * must not be. Those are different graphs, so the pipeline asks for a
 * provider *and a role*.
 */
export const WORKFLOW_ROLES = [
  "text_to_image",
  "text_to_image_ref",
  "image_to_video",
  "speech_to_video",
] as const;
export type WorkflowRole = (typeof WORKFLOW_ROLES)[number];

/**
 * How one `{{variable}}` in a workflow graph is filled in.
 *
 * `binds` is the join between a user's arbitrary graph and the pipeline's
 * fixed vocabulary: the image stage hands over a prompt and does not care
 * that this particular workflow calls it `{{positive}}`. A variable bound to
 * `free` is never set by the pipeline — it is a knob the user exposes to
 * themselves in the editor.
 */
export type WorkflowVariable = {
  name: string;
  type: "string" | "number" | "boolean" | "image";
  binds:
    | "prompt"
    | "negativePrompt"
    | "width"
    | "height"
    | "seed"
    | "refImages"
    | "audio"
    | "free";
  defaultValue?: unknown;
};

/**
 * A ComfyUI workflow, stored as its API-format export.
 *
 * The graph is kept verbatim rather than parsed into columns because it is the
 * user's document: nodes this codebase has never heard of have to survive a
 * round trip through the editor untouched.
 */
export const workflows = sqliteTable(
  "workflows",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    role: text("role", { enum: WORKFLOW_ROLES }).notNull(),
    name: text("name").notNull(),
    // API format (ComfyUI's "Export (API)"), i.e. a flat map of node id to
    // `{ class_type, inputs }` — NOT the editor's own save format, which
    // carries link geometry and cannot be submitted to /prompt.
    graph: text("graph", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    variables: text("variables", { mode: "json" })
      .notNull()
      .$type<WorkflowVariable[]>()
      .default([]),
    // Which node's output to collect. Null means "whichever node produced one",
    // which is unambiguous for the single-SaveImage graphs that are the norm.
    outputNodeId: text("output_node_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // One workflow per role per provider: the pipeline resolves by (provider,
  // role), and a second row would make that pick order-dependent in exactly
  // the way `isDefault` exists to prevent for providers themselves.
  (t) => [unique("workflows_provider_role_unq").on(t.providerId, t.role)],
);

export const promptTemplates = sqliteTable("prompt_templates", {
  // Dotted key naming the generation task, e.g. "story.write".
  key: text("key").primaryKey(),
  section: text("section").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  template: text("template").notNull(),
  // The built-in text this row was last seeded or reset from.
  //
  // "Has this been edited" is `template <> builtinTemplate`, which does not
  // depend on what the built-in library happens to say today — so seeding can
  // upgrade untouched rows and leave edited ones alone. Comparing against the
  // current library instead made those two cases indistinguishable, which is
  // how every install stayed frozen at its first-seeded text.
  builtinTemplate: text("builtin_template").notNull().default(""),
  // Documents every {{var}} the template may use, for the editor's hints.
  variables: text("variables", { mode: "json" })
    .notNull()
    .$type<{ name: string; description: string }[]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const preferences = sqliteTable("preferences", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
  updatedAt: updatedAt(),
});

export const schema = {
  narrativeStyles,
  voiceStyles,
  imageStyles,
  captionStyles,
  directionStyles,
  productionDesignStyles,
  projects,
  characters,
  scenes,
  evaluations,
  voiceovers,
  subtitleCues,
  renders,
  devArtifacts,
  worldBuilding,
  locations,
  props,
  continuityFacts,
  assets,
  jobs,
  jobLogs,
  providers,
  workflows,
  promptTemplates,
  preferences,
};

export { sql };
