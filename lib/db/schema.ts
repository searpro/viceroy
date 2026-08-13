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
  visualGuidance: text("visual_guidance").notNull(),
  evaluationChecklist: text("evaluation_checklist", { mode: "json" })
    .notNull()
    .$type<{ key: string; description: string }[]>(),
  targetSceneCount: integer("target_scene_count").notNull().default(8),
  targetWordCount: integer("target_word_count").notNull().default(320),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
  model: text("model").notNull().default("qwen3-tts-voicedesign"),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const imageStyles = sqliteTable("image_styles", {
  id: id(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  promptPrefix: text("prompt_prefix").notNull().default(""),
  promptSuffix: text("prompt_suffix").notNull().default(""),
  negativePrompt: text("negative_prompt").notNull().default(""),
  model: text("model").notNull(),
  defaultParams: text("default_params", { mode: "json" })
    .notNull()
    .$type<Record<string, number | string>>()
    .default({}),
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

export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    idea: text("idea").notNull(),
    title: text("title"),
    synopsis: text("synopsis"),
    story: text("story"),
    stage: text("stage", { enum: PROJECT_STAGES }).notNull().default("draft"),
    mode: text("mode", { enum: ["auto", "manual"] }).notNull().default("auto"),
    // Set when a stage finished and is waiting on the user in manual mode.
    awaitingReview: integer("awaiting_review", { mode: "boolean" }).notNull().default(false),
    failureReason: text("failure_reason"),

    narrativeStyleId: text("narrative_style_id").references(() => narrativeStyles.id),
    voiceStyleId: text("voice_style_id").references(() => voiceStyles.id),
    imageStyleId: text("image_style_id").references(() => imageStyles.id),
    captionStyleId: text("caption_style_id").references(() => captionStyles.id),

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
    // Keyed by the narrative style's own checklist keys.
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
    kind: text("kind", { enum: ["llm", "image", "audio", "asr"] }).notNull(),
    name: text("name").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKey: text("api_key"),
    model: text("model").notNull(),
    defaultParams: text("default_params", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("providers_kind_idx").on(t.kind)],
);

export const promptTemplates = sqliteTable("prompt_templates", {
  // Dotted key naming the generation task, e.g. "story.write".
  key: text("key").primaryKey(),
  section: text("section").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  template: text("template").notNull(),
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
  projects,
  characters,
  scenes,
  evaluations,
  voiceovers,
  subtitleCues,
  renders,
  assets,
  jobs,
  jobLogs,
  providers,
  promptTemplates,
  preferences,
};

export { sql };
