import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { Fountain, type Script } from "fountain-js";
import {
  characterReferenceImages,
  characters,
  CONTINUITY_SUBJECT_TYPES,
  continuityFacts,
  CRP_VIEWS,
  devArtifacts,
  evaluations,
  locations,
  projects,
  props,
  shotListItems,
  storyboardPanels,
  wardrobeVariants,
  STORYBOARD_CAMERA_ANGLES,
  STORYBOARD_CAMERA_MOVEMENTS,
  STORYBOARD_LENSES,
  STORYBOARD_SHOT_TYPES,
  worldBuilding,
  type ContinuitySubjectType,
  type CrpView,
  type DevArtifactStage,
  type StoryboardShotType,
} from "../db/schema";
import { storeAsset } from "../assets";
import { renderPrompt } from "../prompts";
import { projectAspect, sourceImageFor } from "../resolution";
import { extractSceneDialogue, resolveSpeakers, sceneDialogueFor } from "../screenplay-dialogue";
import { minimumDurationMs, type DialogueLine } from "../timeline/speech";
import { DEFAULT_SEGMENT_DURATION_MS } from "../timeline/build";
import { enqueue } from "../queue";
import type { Db } from "../db/client";
import {
  awaitReview,
  checkAbort,
  groundingInstruction,
  loadProject,
  requireDirectionStyle,
  requireProductionDesignStyle,
  requireProjectId,
  resolveDevProvider,
  resolveProvider,
  type StageContext,
} from "./context";
import { filterLiveRefs, negativePromptFor } from "./images";
import type { ImageBackend } from "../backends/types";
import { parseEvaluation, type EvaluationPayload } from "./story";

/**
 * The Development chain's PR2/PR3 stages — concept through treatment.
 *
 * Every stage below shares one shape with the narrative pipeline's own
 * stages (story.ts, elements.ts): an injected provider, a rendered prompt,
 * and — in auto mode — an automatic enqueue of what comes next. The one
 * difference is that dev-chain stages are gated by an explicit approval
 * (`dev_artifacts.approvedAt` or its per-table equivalent), which the
 * narrative pipeline has no concept of; see `devStageStatus` in chain.ts. In
 * auto mode a stage approves its own draft immediately, the same way the
 * narrative pipeline's `story_eval` auto-advances a passing story without
 * waiting on a click. In manual mode it leaves the draft unapproved and
 * parks the project for review — "continue" then approves it (chain.ts's
 * `advance`) before dispatching the next stage.
 */

function pendingDirection(ctx: StageContext): string {
  return typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction.trim() : "";
}

/** `{{direction}}`'s pre-formatted form, matching `elements.ts`'s own convention. */
function directionBlock(direction: string): string {
  return direction ? `\nAdditional direction from the writer for this redo:\n${direction}` : "";
}

/** The latest version's content for a `dev_artifacts` stage this project has already approved. */
function requireDevArtifactContent(db: Db, projectId: string, stage: DevArtifactStage): string {
  const latest = db
    .select()
    .from(devArtifacts)
    .where(and(eq(devArtifacts.projectId, projectId), eq(devArtifacts.stage, stage)))
    .orderBy(desc(devArtifacts.version))
    .get();
  if (!latest?.content) {
    throw new Error(`Project ${projectId} has no "${stage}" yet — it must be generated first`);
  }
  return latest.content;
}

/**
 * Write a new version of a `dev_artifacts` stage.
 *
 * Always a new row, never an overwrite of the latest one — a stage can be
 * redone more than once before it's approved, and each redo is its own
 * version (see the field comment on `dev_artifacts.version` in
 * lib/db/schema.ts), so the history a user's earlier direction produced is
 * never lost under a later one.
 */
function writeDevArtifact(
  db: Db,
  projectId: string,
  stage: DevArtifactStage,
  content: string,
  direction: string,
  autoApprove: boolean,
): void {
  const latest = db
    .select()
    .from(devArtifacts)
    .where(and(eq(devArtifacts.projectId, projectId), eq(devArtifacts.stage, stage)))
    .orderBy(desc(devArtifacts.version))
    .get();

  const priorHistory = latest?.directionHistory ?? [];
  db.insert(devArtifacts)
    .values({
      projectId,
      stage,
      version: (latest?.version ?? 0) + 1,
      content,
      approvedAt: autoApprove ? new Date() : null,
      directionHistory: direction ? [...priorHistory, direction] : priorHistory,
    })
    .run();
}

/** In auto mode, hand off to the next stage; in manual mode, park for review. */
function continueDevChain(
  ctx: StageContext,
  projectId: string,
  mode: "auto" | "manual",
  next: DevArtifactStage | "characters" | "world_building" | "continuity",
): void {
  if (mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  enqueue(ctx.db, { type: next, projectId });
}

/** Stage 1 (of PR2's five) — the starting idea becomes a one-paragraph concept. */
export async function runConcept(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const direction = pendingDirection(ctx);

  const prompt = renderPrompt(ctx.db, "dev.concept", {
    // Context mode's source material is the ground truth to develop from;
    // Idea mode's one-liner is the starting point to elaborate — the same
    // split `runSynopsis` makes, minus a second template, since this prompt
    // frames either input the same way ("Starting point").
    idea: project.context ?? project.idea,
    genreGuidance: directionStyle.genreGuidance,
    toneGuidance: directionStyle.toneGuidance,
    direction: directionBlock(direction),
    groundingInstruction: groundingInstruction(project),
  });

  ctx.log(`Generating concept with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.85,
  });

  writeDevArtifact(ctx.db, projectId, "concept", content.trim(), direction, project.mode === "auto");
  ctx.log("Concept written");

  continueDevChain(ctx, projectId, project.mode, "logline");
}

/** Stage 2 — the approved concept becomes a single-sentence logline. */
export async function runLogline(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const direction = pendingDirection(ctx);

  const prompt = renderPrompt(ctx.db, "dev.logline", {
    concept,
    genreGuidance: directionStyle.genreGuidance,
    toneGuidance: directionStyle.toneGuidance,
    direction: directionBlock(direction),
  });

  ctx.log(`Generating logline with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });

  writeDevArtifact(ctx.db, projectId, "logline", content.trim(), direction, project.mode === "auto");
  ctx.log("Logline written");

  continueDevChain(ctx, projectId, project.mode, "characters");
}

type DevCharacterPayload = {
  characters?: { name?: unknown; description?: unknown; arc?: unknown }[];
};

/**
 * Stage 3 — the principal cast, each with an arc.
 *
 * Unlike the narrative pipeline's `elements` (which skips extraction if a
 * cast already exists, because it's resumable across a crash rather than
 * redoable), this stage owns the whole cast outright: a redo — direct, or as
 * the flow-through of an earlier concept/logline redo reaching this far via
 * `regenerate` — replaces it rather than appending to it, per ADR 0003's
 * "redoing 'characters' clears the character rows added by that stage".
 */
export async function runDevCharacters(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const logline = requireDevArtifactContent(ctx.db, projectId, "logline");
  const direction = pendingDirection(ctx);

  ctx.log(`Extracting characters and arcs with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const payload = await ctx.llmClient(provider).chatJson<DevCharacterPayload>({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.characters", {
          concept,
          logline,
          genreGuidance: directionStyle.genreGuidance,
          toneGuidance: directionStyle.toneGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.5,
  });

  const rows = (payload.characters ?? [])
    .filter((c): c is { name: string; description: string; arc: string } =>
      typeof c?.name === "string" &&
      c.name.trim().length > 0 &&
      typeof c?.description === "string" &&
      c.description.trim().length > 0 &&
      typeof c?.arc === "string" &&
      c.arc.trim().length > 0,
    )
    .slice(0, 5)
    .map((c) => ({
      projectId,
      name: c.name.trim(),
      description: c.description.trim(),
      arc: c.arc.trim(),
    }));

  if (rows.length === 0) {
    throw new Error(`Project ${projectId} — character extraction returned no usable characters`);
  }

  ctx.db.delete(characters).where(eq(characters.projectId, projectId)).run();
  ctx.db.insert(characters).values(rows).run();

  const priorHistory = project.charactersDirectionHistory;
  ctx.db
    .update(projects)
    .set({
      charactersApprovedAt: project.mode === "auto" ? new Date() : null,
      charactersDirectionHistory: direction ? [...priorHistory, direction] : priorHistory,
    })
    .where(eq(projects.id, projectId))
    .run();

  ctx.log(`${rows.length} character(s) written: ${rows.map((r) => r.name).join(", ")}`);

  continueDevChain(ctx, projectId, project.mode, "world_building");
}

type WorldBuildingPayload = {
  rules?: unknown;
  locations?: { name?: unknown; description?: unknown }[];
  props?: { name?: unknown; description?: unknown }[];
};

/** The cast, formatted for a prompt — reused by both `world_building` and `story_structure`. */
function castSummary(db: Db, projectId: string): string {
  const cast = db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  return cast.map((c) => `- ${c.name}: ${c.description} (arc: ${c.arc ?? "—"})`).join("\n") || "(no cast yet)";
}

/** The world so far, formatted for `story_structure`'s prompt. */
function worldSummary(db: Db, projectId: string): string {
  const row = db.select().from(worldBuilding).where(eq(worldBuilding.projectId, projectId)).get();
  const locs = db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = db.select().from(props).where(eq(props.projectId, projectId)).all();

  const parts = [
    row?.content ? row.content : "(no world-building notes yet)",
    locs.length > 0 ? `Locations:\n${locs.map((l) => `- ${l.name}: ${l.description}`).join("\n")}` : "",
    items.length > 0 ? `Props:\n${items.map((p) => `- ${p.name}: ${p.description}`).join("\n")}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Stage 4 — rules/tone/theme prose, plus the locations and props derived
 * from it. Three tables, one generation, one approval gate — see the comment
 * on `worldBuilding` in lib/db/schema.ts for why `locations`/`props` share
 * its `approvedAt` rather than carrying their own.
 *
 * `locations`/`props` mirror `characters`' visual-consistency columns exactly
 * (name, description, imageAssetId, refInputName, imageSource), but nothing
 * populates the image ones yet — reference-portrait generation for them is a
 * later PR's scope, the same way `character_images` postdates `elements`.
 * `filterLiveRefs` (lib/pipeline/images.ts) already works against either
 * unchanged, since it only depends on that shared column shape.
 */
export async function runWorldBuilding(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const logline = requireDevArtifactContent(ctx.db, projectId, "logline");
  const direction = pendingDirection(ctx);

  ctx.log(`Building the world with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const payload = await ctx.llmClient(provider).chatJson<WorldBuildingPayload>({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.world_building", {
          concept,
          logline,
          castSummary: castSummary(ctx.db, projectId),
          genreGuidance: directionStyle.genreGuidance,
          toneGuidance: directionStyle.toneGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.6,
  });

  const rules = typeof payload.rules === "string" ? payload.rules.trim() : "";
  if (!rules) {
    throw new Error(`Project ${projectId} — world building returned no rules/tone/theme prose`);
  }

  const locationRows = (payload.locations ?? [])
    .filter(
      (l): l is { name: string; description: string } =>
        typeof l?.name === "string" && l.name.trim().length > 0 && typeof l?.description === "string",
    )
    .slice(0, 6)
    .map((l) => ({ projectId, name: l.name.trim(), description: l.description.trim() }));

  const propRows = (payload.props ?? [])
    .filter(
      (p): p is { name: string; description: string } =>
        typeof p?.name === "string" && p.name.trim().length > 0 && typeof p?.description === "string",
    )
    .slice(0, 6)
    .map((p) => ({ projectId, name: p.name.trim(), description: p.description.trim() }));

  // A redo replaces the world wholesale — same reasoning as `runDevCharacters`
  // above, and the same cascade `DISCARD["world_building"]` in lib/projects.ts
  // applies when an *earlier* stage's redo invalidates this one instead.
  ctx.db.delete(locations).where(eq(locations.projectId, projectId)).run();
  ctx.db.delete(props).where(eq(props.projectId, projectId)).run();
  if (locationRows.length > 0) ctx.db.insert(locations).values(locationRows).run();
  if (propRows.length > 0) ctx.db.insert(props).values(propRows).run();

  const existing = ctx.db.select().from(worldBuilding).where(eq(worldBuilding.projectId, projectId)).get();
  const priorHistory = existing?.directionHistory ?? [];
  const approvedAt = project.mode === "auto" ? new Date() : null;
  const historyPatch = direction ? [...priorHistory, direction] : priorHistory;

  if (existing) {
    ctx.db
      .update(worldBuilding)
      .set({ content: rules, approvedAt, directionHistory: historyPatch })
      .where(eq(worldBuilding.id, existing.id))
      .run();
  } else {
    ctx.db
      .insert(worldBuilding)
      .values({ projectId, content: rules, approvedAt, directionHistory: historyPatch })
      .run();
  }

  ctx.log(
    `World building written: ${locationRows.length} location(s), ${propRows.length} prop(s)`,
  );

  continueDevChain(ctx, projectId, project.mode, "story_structure");
}

/**
 * Stage 5 — the approved concept, logline, cast and world become a numbered
 * beat structure.
 *
 * Behaves exactly like the four stages above: auto mode approves its own
 * draft and hands off to whatever `DEV_CHAIN_STAGES` names next ("beat_sheet",
 * PR3's own stage 6, below).
 */
export async function runStoryStructure(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const logline = requireDevArtifactContent(ctx.db, projectId, "logline");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing story structure with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.story_structure", {
          concept,
          logline,
          castSummary: castSummary(ctx.db, projectId),
          worldSummary: worldSummary(ctx.db, projectId),
          genreGuidance: directionStyle.genreGuidance,
          pacingGuidance: directionStyle.pacingGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.7,
  });

  writeDevArtifact(ctx.db, projectId, "story_structure", content.trim(), direction, project.mode === "auto");
  ctx.log("Story structure written");

  continueDevChain(ctx, projectId, project.mode, "beat_sheet");
}

/**
 * Stage 6 — the approved story structure becomes a finer-grained beat sheet.
 *
 * Same shape as `runStoryStructure` above, minus world/pacing's extra inputs
 * — per finding F10's 4096-token cap, this prompt carries only what it needs
 * to expand (concept for premise, the structure itself, cast for who's in
 * each beat), not the whole chain's history.
 */
export async function runBeatSheet(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const storyStructure = requireDevArtifactContent(ctx.db, projectId, "story_structure");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing beat sheet with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.beat_sheet", {
          concept,
          storyStructure,
          castSummary: castSummary(ctx.db, projectId),
          genreGuidance: directionStyle.genreGuidance,
          pacingGuidance: directionStyle.pacingGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.7,
  });

  writeDevArtifact(ctx.db, projectId, "beat_sheet", content.trim(), direction, project.mode === "auto");
  ctx.log("Beat sheet written");

  continueDevChain(ctx, projectId, project.mode, "treatment");
}

/**
 * Stage 7 — the approved beat sheet becomes a prose treatment.
 *
 * "treatment" hands off to "screenplay" next per `DEV_CHAIN_STAGES`, which
 * has no `STAGE_HANDLERS` entry yet (PR4+ scope) — the same graceful landing
 * `runStoryStructure`'s doc comment describes for "beat_sheet" before this PR.
 */
export async function runTreatment(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const beatSheet = requireDevArtifactContent(ctx.db, projectId, "beat_sheet");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing treatment with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.treatment", {
          concept,
          beatSheet,
          castSummary: castSummary(ctx.db, projectId),
          genreGuidance: directionStyle.genreGuidance,
          toneGuidance: directionStyle.toneGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.75,
  });

  writeDevArtifact(ctx.db, projectId, "treatment", content.trim(), direction, project.mode === "auto");
  ctx.log("Treatment written");

  continueDevChain(ctx, projectId, project.mode, "screenplay");
}

/**
 * Parse a Fountain document and reject anything that doesn't look like one.
 *
 * `fountain-js` never throws on malformed input — unrecognized text just
 * becomes `action` tokens (verified against the library directly: a plain
 * prose paragraph parses cleanly into a single `action` token, no error, no
 * failure flag). So "did this parse as Fountain" has to be judged from the
 * token shape rather than a caught exception: a screenplay with no scene
 * headings and no character cues is prose wearing a Fountain-parser's
 * output, not a screenplay, however cleanly `parse()` returned. Both this
 * function and the PDF export route share it, so "valid Fountain" means the
 * same thing in both places.
 */
export function parseScreenplay(content: string): Script {
  const script = new Fountain().parse(content, true);
  const tokens = script.tokens ?? [];
  const hasScene = tokens.some((t) => t.type === "scene_heading");
  const hasDialogue = tokens.some((t) => t.type === "character");
  if (!hasScene || !hasDialogue) {
    throw new Error(
      "Screenplay generation did not produce valid Fountain — no scene headings or no dialogue " +
        "found after parsing. Refusing to store it as an approved screenplay.",
    );
  }
  return script;
}

/**
 * Stage 8 — the approved treatment becomes a full Fountain-syntax screenplay.
 *
 * Unlike every dev-chain stage above, this one validates its own output
 * before writing it: `parseScreenplay` throws if the LLM's response doesn't
 * parse into a real screenplay (no scene headings, no dialogue), which
 * propagates out of this handler exactly the way `runDevCharacters`'s "no
 * usable characters" and `runWorldBuilding`'s "no rules prose" throws do —
 * caught by the worker (worker/index.ts), which calls `fail()` and leaves no
 * `dev_artifacts` row behind for this stage. A malformed generation is
 * therefore a failed job awaiting retry/review, never a silently-broken
 * screenplay sitting in the chain for stage 9 (revision) or 11-12 (script/
 * scene breakdown) to choke on later.
 *
 * "screenplay" hands off to "screenplay_revision" next per `DEV_CHAIN_STAGES`
 * — `runScreenplayRevision`, below, PR5's own stage 9.
 */
export async function runScreenplay(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const directionStyle = requireDirectionStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const treatment = requireDevArtifactContent(ctx.db, projectId, "treatment");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing screenplay with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.screenplay", {
          concept,
          treatment,
          castSummary: castSummary(ctx.db, projectId),
          genreGuidance: directionStyle.genreGuidance,
          toneGuidance: directionStyle.toneGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.7,
  });

  const trimmed = content.trim();
  ctx.progress(0.8);
  checkAbort(ctx);

  // Validate before writing — see `parseScreenplay`'s doc comment for why
  // this stage, alone among the dev-chain stages so far, can't just store
  // whatever the model returned.
  parseScreenplay(trimmed);

  writeDevArtifact(ctx.db, projectId, "screenplay", trimmed, direction, project.mode === "auto");
  ctx.log("Screenplay written");

  continueDevChain(ctx, projectId, project.mode, "screenplay_revision");
}

/**
 * The checklist `runScreenplayRevision` judges a screenplay against.
 *
 * There is no style-table equivalent to draw this from — Direction Style
 * deliberately carries no checklist field (ADR-scoped decision from PR2's
 * design: genre/tone/pacing guidance for the *writer*, not a rubric for a
 * judge) — so this is a standalone module-level constant, the same shape as
 * `FACTUAL_GROUNDING_CHECKLIST_ITEM` in context.ts.
 */
const SCREENPLAY_CHECKLIST: { key: string; description: string }[] = [
  {
    key: "scene_structure",
    description:
      "Scenes are well-formed Fountain (a slugline, action/dialogue, a clear turn or beat) " +
      "and, taken in order, cover the story from setup through resolution.",
  },
  {
    key: "character_voice",
    description:
      "Each character's dialogue reads distinctly theirs — word choice, rhythm, what they " +
      "would and would not say — rather than interchangeable lines redistributed by cue.",
  },
  {
    key: "dialogue_quality",
    description:
      "Dialogue does the scene's work through subtext and conflict, not by characters " +
      "stating what they want or feel outright.",
  },
  {
    key: "pacing",
    description:
      "No scene overstays a beat that has already landed, and no turn arrives before the " +
      "scene has earned it — the read moves at the story's own speed, not the treatment's.",
  },
  {
    key: "fountain_cleanliness",
    description:
      "Strict Fountain syntax throughout: sluglines in caps starting INT./EXT., character " +
      "cues in caps immediately before their dialogue, no stray markdown, no prose outside " +
      "the screenplay's own elements.",
  },
];

function formatScreenplayChecklist(): string {
  return SCREENPLAY_CHECKLIST.map((c) => `- ${c.key}: ${c.description}`).join("\n");
}

/** How many screenplay-revision-loop evaluations this project has recorded so far. */
function countScreenplayEvaluations(db: Db, projectId: string): number {
  return db.select({ id: evaluations.id }).from(evaluations).where(eq(evaluations.projectId, projectId)).all()
    .length;
}

/**
 * Stage 9 — evaluate the approved screenplay against `SCREENPLAY_CHECKLIST`
 * and, if it falls short, revise and re-judge, until it passes or the QC
 * iteration threshold is reached.
 *
 * Mirrors `runStoryEval`/`runStoryRevise` (story.ts) exactly in mechanism —
 * same evaluator/reviser split, same `parseEvaluation` "trust the scores over
 * the stated verdict" logic, same `qcMaxIterations` threshold-then-await-review
 * behaviour, same `evaluations` table (see its doc comment in
 * lib/db/schema.ts for why one shared table needs no format-specific
 * discriminator column). The one structural difference is deliberate: the
 * narrative pipeline's loop is two job types (`story_eval`/`story_revise`)
 * because `nextStep` walks a flat job sequence with no notion of "waiting for
 * approval" — but `DEV_CHAIN_STAGES` is one entry per `dev_artifacts` stage,
 * and `screenplay_revision` is that one entry (see `JOB_TYPES`'s comment in
 * lib/db/schema.ts: dev-chain job types come from `DEV_CHAIN_STAGES`, not a
 * second parallel list a `screenplay_eval`/`screenplay_revise` pair would
 * need). So this stage is a single job that loops internally — evaluate,
 * and if it doesn't pass, revise and evaluate again, all within one call —
 * rather than two jobs re-queuing each other.
 */
export async function runScreenplayRevision(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const provider = resolveDevProvider(ctx.db);

  let content = requireDevArtifactContent(ctx.db, projectId, "screenplay");
  const allowedKeys = SCREENPLAY_CHECKLIST.map((c) => c.key);
  const checklist = formatScreenplayChecklist();

  for (;;) {
    const iteration = countScreenplayEvaluations(ctx.db, projectId) + 1;

    ctx.log(`Evaluating screenplay (attempt ${iteration}) with ${provider.model}`);
    ctx.progress(0.1);
    checkAbort(ctx);

    const raw = await ctx.llmClient(provider).chatJson<EvaluationPayload>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "dev.screenplay_evaluate", { screenplay: content, checklist }),
        },
      ],
      temperature: 0.2,
    });

    const parsed = parseEvaluation(raw, allowedKeys);

    ctx.db
      .insert(evaluations)
      .values({
        projectId,
        iteration,
        verdict: parsed.verdict,
        overallScore: parsed.overallScore,
        dimensions: parsed.dimensions,
        issues: parsed.issues,
        model: provider.model,
      })
      .run();

    ctx.log(
      `Evaluation ${iteration}: ${parsed.verdict}` +
        (parsed.overallScore ? ` (mean ${parsed.overallScore.toFixed(2)}/5)` : "") +
        (parsed.issues.length > 0 ? `, ${parsed.issues.length} issue(s)` : ""),
    );

    if (parsed.verdict === "pass") {
      writeDevArtifact(ctx.db, projectId, "screenplay_revision", content, "", project.mode === "auto");
      ctx.log("Screenplay passed evaluation");
      continueDevChain(ctx, projectId, project.mode, "story_bible");
      return;
    }

    if (iteration >= ctx.config.qcMaxIterations) {
      // Leave the latest (still-failing) draft behind as an unapproved
      // `dev_artifacts` row rather than nothing at all — a human reviewing
      // this project has something concrete to look at, and can approve it
      // as-is via the ordinary "continue" mechanism (chain.ts's `advance`) if
      // they judge it good enough despite the evaluator, exactly the same
      // override every other dev-chain stage's manual review already allows.
      writeDevArtifact(ctx.db, projectId, "screenplay_revision", content, "", false);
      const reason =
        `Screenplay still failing evaluation after ${iteration} attempt(s) — ` +
        `QC threshold reached, stopping for review`;
      awaitReview(ctx.db, projectId, reason);
      ctx.log(reason, "warn");
      return;
    }

    ctx.log(`Revising screenplay against ${parsed.issues.length} issue(s)`);
    checkAbort(ctx);

    const { content: revised } = await ctx.llmClient(provider).chat({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "dev.screenplay_revise", {
            screenplay: content,
            issues: parsed.issues.map((i) => `- [${i.severity}] ${i.note}`).join("\n"),
          }),
        },
      ],
      temperature: 0.7,
    });

    const trimmed = revised.trim();
    // Same validation `runScreenplay` applies to a fresh generation — a
    // revision that has drifted out of Fountain is exactly as unusable
    // downstream as a first draft that never was one.
    parseScreenplay(trimmed);
    content = trimmed;
  }
}

/**
 * Stage 10 — the capstone. Assembles one readable document from every
 * approved Development artifact: concept through the final screenplay
 * revision, the cast, and the world.
 *
 * Deliberately not a generation: every source here is already-approved prose
 * a human signed off on, so this stage's job is formatting, not writing.
 * No provider is resolved and no `sd-api` call is made — the acceptance bar
 * this stage has to clear is "assembles the document", not "writes good
 * prose". Left unapproved on write, like every other dev-chain draft — the
 * ordinary "approve and continue" mechanism (chain.ts's `advance`) is what
 * gates Development's `devNextStep` "complete" state on a human's sign-off,
 * not a second approval path invented just for this stage.
 */
export async function runStoryBible(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No such project: ${projectId}`);

  const concept = requireDevArtifactContent(ctx.db, projectId, "concept");
  const logline = requireDevArtifactContent(ctx.db, projectId, "logline");
  const storyStructure = requireDevArtifactContent(ctx.db, projectId, "story_structure");
  const beatSheet = requireDevArtifactContent(ctx.db, projectId, "beat_sheet");
  const treatment = requireDevArtifactContent(ctx.db, projectId, "treatment");
  // The final, revised screenplay — not the pre-revision "screenplay" stage's
  // own content — is what belongs in the bible: it is the version Development
  // actually signed off on.
  const finalScreenplay = requireDevArtifactContent(ctx.db, projectId, "screenplay_revision");

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const world = ctx.db.select().from(worldBuilding).where(eq(worldBuilding.projectId, projectId)).get();
  const locs = ctx.db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = ctx.db.select().from(props).where(eq(props.projectId, projectId)).all();

  const worldSection = [
    world?.content ?? "",
    locs.length > 0 ? `Locations:\n${locs.map((l) => `- ${l.name}: ${l.description}`).join("\n")}` : "",
    items.length > 0 ? `Props:\n${items.map((p) => `- ${p.name}: ${p.description}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const castSection = cast.map((c) => `- ${c.name}: ${c.description} (Arc: ${c.arc ?? "—"})`).join("\n");

  const content = [
    `# Concept\n\n${concept}`,
    `# Logline\n\n${logline}`,
    `# Characters & Arcs\n\n${castSection}`,
    `# World Building\n\n${worldSection}`,
    `# Story Structure\n\n${storyStructure}`,
    `# Beat Sheet\n\n${beatSheet}`,
    `# Treatment\n\n${treatment}`,
    `# Screenplay\n\n${finalScreenplay}`,
  ].join("\n\n");

  ctx.progress(0.5);
  writeDevArtifact(ctx.db, projectId, "story_bible", content, "", false);
  ctx.log("Story bible assembled");
  ctx.progress(1);
}

/**
 * Stage 11 (Preproduction's first) — the approved story bible becomes a
 * coarse script breakdown: what each scene needs to shoot, not how it reads.
 *
 * Deliberately reads only the story bible, not a stack of individual
 * upstream artifacts the way the Development stages above do — the bible is
 * already Development's own condensed capstone (concept through the final
 * screenplay, per `runStoryBible`), so handing this stage that one document
 * is the scoped choice per finding F10's 4096-token cap, not a violation of
 * it. No Direction Style guidance here: a breakdown is a logistics document
 * (cast present, key props, key locations, day/night, interior/exterior),
 * not prose the writer's genre/tone/pacing register has anything to say
 * about — see the M7 detail page's own note that Production Design Style
 * guidance stays unconsumed until PR8's aesthetic stage exists.
 *
 * "script_breakdown" hands off to "scene_breakdown" next per
 * `DEV_CHAIN_STAGES` — `runSceneBreakdown`, below, this same PR's stage 12.
 */
export async function runScriptBreakdown(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const provider = resolveDevProvider(ctx.db);

  const storyBible = requireDevArtifactContent(ctx.db, projectId, "story_bible");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing script breakdown with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.script_breakdown", {
          storyBible,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.4,
  });

  writeDevArtifact(
    ctx.db,
    projectId,
    "script_breakdown",
    content.trim(),
    direction,
    project.mode === "auto",
  );
  ctx.log("Script breakdown written");

  continueDevChain(ctx, projectId, project.mode, "scene_breakdown");
}

/**
 * Stage 12 — the approved script breakdown, elaborated into a finer-grained
 * per-scene document.
 *
 * The coarse/fine split between this stage and `runScriptBreakdown` above:
 * "script_breakdown" names what a scene needs at the scene level (cast, key
 * props, key locations, day/night, INT/EXT) — the level an AD blocks a
 * shooting schedule from. "scene_breakdown" elaborates each of those entries
 * down to what a specific take needs — exact prop instances and who's
 * carrying them, blocking/entrances/exits, continuity notes against
 * neighbouring scenes, and any special equipment, stunts or effects a scene
 * calls for. Two artifacts rather than one longer one because they serve two
 * different readers at two different moments of prep, the same reasoning
 * `runStoryStructure`/`runBeatSheet` already split structure from beat sheet.
 *
 * Reads the immediately-prior artifact plus the cast/world summaries the
 * story bible itself was built from — not the whole bible a second time —
 * same scoping discipline as `runBeatSheet`/`runTreatment` above (finding
 * F10).
 *
 * "scene_breakdown" hands off to "continuity" next per `DEV_CHAIN_STAGES` —
 * `runContinuity`, below, this same PR's stage 13.
 */
export async function runSceneBreakdown(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const provider = resolveDevProvider(ctx.db);

  const scriptBreakdown = requireDevArtifactContent(ctx.db, projectId, "script_breakdown");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing scene breakdown with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.scene_breakdown", {
          scriptBreakdown,
          castSummary: castSummary(ctx.db, projectId),
          worldSummary: worldSummary(ctx.db, projectId),
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.4,
  });

  writeDevArtifact(
    ctx.db,
    projectId,
    "scene_breakdown",
    content.trim(),
    direction,
    project.mode === "auto",
  );
  ctx.log("Scene breakdown written");

  continueDevChain(ctx, projectId, project.mode, "continuity");
}

type ContinuityFactCandidate = {
  subjectType?: unknown;
  subjectName?: unknown;
  sceneId?: unknown;
  fact?: unknown;
  conflict?: unknown;
};
type ContinuityPayload = { facts?: ContinuityFactCandidate[] };

/**
 * Resolve the LLM's named subject ("Reyna", "the pick set") back to the row
 * it means, case-insensitively — the model names a subject, not an id, the
 * same way it names a cast member or a location when writing prose. Three
 * lookups rather than one generic one: `characters`/`locations`/`props` are
 * different tables with different columns beyond `id`/`name`, and a fact's
 * `subjectType` already tells this function which one to look in, so there's
 * nothing a shared query would save.
 */
function resolveSubject(
  db: Db,
  projectId: string,
  subjectType: ContinuitySubjectType,
  name: string,
): { id: string; name: string } | undefined {
  const normalized = name.trim().toLowerCase();
  if (subjectType === "character") {
    return db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(eq(characters.projectId, projectId))
      .all()
      .find((r) => r.name.trim().toLowerCase() === normalized);
  }
  if (subjectType === "location") {
    return db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(eq(locations.projectId, projectId))
      .all()
      .find((r) => r.name.trim().toLowerCase() === normalized);
  }
  return db
    .select({ id: props.id, name: props.name })
    .from(props)
    .where(eq(props.projectId, projectId))
    .all()
    .find((r) => r.name.trim().toLowerCase() === normalized);
}

/**
 * Every continuity fact already on record for this project, formatted for
 * the extraction prompt — so a redo's LLM call can see what an earlier run
 * already established and flag a genuine contradiction itself, rather than
 * this stage running any rules-based text-contradiction check of its own.
 * Empty on a project's first continuity pass, same as `castSummary`'s "(no
 * cast yet)" fallback elsewhere in this file.
 */
function existingFactsSummary(db: Db, projectId: string): string {
  const rows = db.select().from(continuityFacts).where(eq(continuityFacts.projectId, projectId)).all();
  if (rows.length === 0) return "(none yet — this is the first continuity pass)";
  return rows
    .map(
      (r) =>
        `- [${r.subjectType}] ${r.subjectName}: ${r.fact}` +
        (r.source === "conflict" ? " (unresolved conflict)" : ""),
    )
    .join("\n");
}

/**
 * Stage 13 — extracts continuity facts (a character's scar, where a prop was
 * left, a location's established geography) from the approved Story Bible
 * and the script/scene breakdowns, for a human to confirm or correct — "the
 * system extracts continuity facts... automatically, flags conflicts as they
 * appear in later stages, and a human approves or corrects — never silent
 * auto-resolution" (the M7 detail page's own "Continuity" section). This is
 * the same posture as the story-quality evaluator: assistive, not
 * authoritative.
 *
 * Writes `continuity_facts` rows directly rather than a `dev_artifacts` row
 * (see that table's own comment in lib/db/schema.ts) — so, like
 * "characters"/"world_building", this stage sits in `DEV_CHAIN_STAGES` but
 * not `DEV_ARTIFACT_STAGES`, and `devStageStatus`/`approveDevStage` (chain.ts)
 * and `DISCARD` (lib/projects.ts) special-case it the same way those two
 * already are.
 *
 * Reads the Story Bible plus both breakdowns, per the M7 detail page's own
 * scope for this stage — a wider input than any other dev-chain stage takes
 * (finding F10's 4096-token cap is a real risk here, more than anywhere else
 * in this chain: the bible alone already runs long, and both breakdowns are
 * appended on top of it). Accepted rather than trimmed, because continuity's
 * whole job is cross-referencing what the bible established against what the
 * breakdowns derived from it — narrowing the input would narrow exactly what
 * this stage exists to catch. If this proves to overrun the cap in practice,
 * the fix is a condensed digest of the bible (concept/characters/world only,
 * dropping the prose treatment and full screenplay text it also carries),
 * not dropping a whole source document.
 *
 * Never overwrites a prior run's facts: `DISCARD["continuity"]`
 * (lib/projects.ts) only clears the approval gate on a redo, deliberately
 * leaving every earlier `continuity_facts` row in place — that history is
 * what lets this stage's own LLM call notice a contradiction against
 * something an earlier pass already established (`existingFactsSummary`
 * above). Conflict detection is therefore entirely the model's own judgment,
 * given that history as prompt context, not a rules-based text-contradiction
 * check this stage runs itself — per the M7 detail page's "LLM-assisted...
 * flags conflicts", and per this PR's own scope note against over-engineering
 * that. A fact identical to one already on record for the same subject
 * (same text, case-insensitive) is skipped rather than reinserted, so an
 * unchanged redo doesn't pad the table with duplicate rows on every run —
 * but a fact the model flags as conflicting with the record is always kept
 * as its own new row (`source: "conflict"`), never merged into or replacing
 * the fact it conflicts with.
 *
 * "Approved" for this stage means only that extraction has run at least once
 * and a human has continued past it — not that every conflict is resolved.
 * PR7's own scope, per the M7 detail page, is "no UI review surface beyond a
 * flat list... a richer conflict-resolution UI can follow" — blocking
 * approval on every conflict being resolved would need that richer UI to
 * exist first. A conflict left unresolved at approval time stays visible
 * (and individually resolvable, via the continuity-facts API route) after
 * approval; it just doesn't gate the chain the way an unapproved draft does.
 *
 * "continuity" is currently the last stage `DEV_CHAIN_STAGES` names, so this
 * stage does not hand off further in auto mode — the same "derive, don't
 * record" landing every stage at the end of the chain-so-far sits in until a
 * later PR extends `DEV_CHAIN_STAGES` past it (see `runScreenplay`'s doc
 * comment for the general pattern). Manual mode still parks for review,
 * exactly as every stage above does.
 */
export async function runContinuity(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const provider = resolveDevProvider(ctx.db);

  // Chain order already guarantees story_bible/script_breakdown are approved
  // by the time continuity runs — this is a defensive existence check, not
  // context for the prompt. Passing their full text on top of the scene
  // breakdown measured out to 4432 tokens against a 4096 cap (finding F10)
  // the first time this ran for real; castSummary/worldSummary are the same
  // entity-focused condensation `scene_breakdown`'s own prompt already uses.
  requireDevArtifactContent(ctx.db, projectId, "story_bible");
  requireDevArtifactContent(ctx.db, projectId, "script_breakdown");
  const sceneBreakdown = requireDevArtifactContent(ctx.db, projectId, "scene_breakdown");
  const direction = pendingDirection(ctx);

  ctx.log(`Extracting continuity facts with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const payload = await ctx.llmClient(provider).chatJson<ContinuityPayload>({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.continuity", {
          castSummary: castSummary(ctx.db, projectId),
          worldSummary: worldSummary(ctx.db, projectId),
          sceneBreakdown,
          existingFacts: existingFactsSummary(ctx.db, projectId),
          direction: directionBlock(direction),
        }),
      },
    ],
    temperature: 0.3,
  });

  const candidates = (payload.facts ?? []).filter(
    (
      f,
    ): f is { subjectType: ContinuitySubjectType; subjectName: string; sceneId: unknown; fact: string; conflict: unknown } =>
      typeof f?.subjectType === "string" &&
      (CONTINUITY_SUBJECT_TYPES as readonly string[]).includes(f.subjectType) &&
      typeof f?.subjectName === "string" &&
      f.subjectName.trim().length > 0 &&
      typeof f?.fact === "string" &&
      f.fact.trim().length > 0,
  );

  if (candidates.length === 0) {
    throw new Error(`Project ${projectId} — continuity extraction returned no usable facts`);
  }

  const existing = ctx.db.select().from(continuityFacts).where(eq(continuityFacts.projectId, projectId)).all();

  let written = 0;
  let dropped = 0;
  for (const candidate of candidates) {
    const subject = resolveSubject(ctx.db, projectId, candidate.subjectType, candidate.subjectName);
    if (!subject) {
      // Degrade gracefully, log a warning, never fail the whole stage over
      // one bad reference — the same discipline `filterLiveRefs` (images.ts)
      // already applies to a dangling `refInputName`.
      dropped++;
      ctx.log(
        `Continuity fact named "${candidate.subjectName}" as a ${candidate.subjectType}, which doesn't match ` +
          `any known ${candidate.subjectType} in this project — dropping it`,
        "warn",
      );
      continue;
    }

    const factText = candidate.fact.trim();
    const alreadyRecorded = existing.some(
      (row) => row.subjectId === subject.id && row.fact.trim().toLowerCase() === factText.toLowerCase(),
    );
    if (alreadyRecorded) continue;

    const sceneId =
      typeof candidate.sceneId === "string" && candidate.sceneId.trim().length > 0
        ? candidate.sceneId.trim()
        : typeof candidate.sceneId === "number"
          ? String(candidate.sceneId)
          : null;

    ctx.db
      .insert(continuityFacts)
      .values({
        projectId,
        sceneId,
        subjectType: candidate.subjectType,
        subjectId: subject.id,
        subjectName: subject.name,
        fact: factText,
        source: candidate.conflict === true ? "conflict" : "extracted",
      })
      .run();
    written++;
  }

  ctx.log(`${written} continuity fact(s) written` + (dropped > 0 ? `, ${dropped} dropped (unresolved subject)` : ""));

  ctx.db
    .update(projects)
    .set({ continuityApprovedAt: project.mode === "auto" ? new Date() : null })
    .where(eq(projects.id, projectId))
    .run();

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  // "Continuity" does not hand off to "visual_bible" itself, even in auto
  // mode: it is a table stage, not a `dev_artifacts` one, and — like
  // "characters"/"world_building" before it — its own auto-approval only
  // ever meant "a human doesn't have to click through this specific stage,"
  // never "the chain keeps moving on its own past it." The generic
  // "continue" mechanism (chain.ts's `advance`) is what starts "visual_bible"
  // once a human (or auto-mode's own review loop) reaches it via `nextStep`.
  ctx.log("Continuity extracted — advance to Preproduction's visual bible next");
}

/** The Production Design Style's three guidance fields, formatted as one block. */
function productionDesignSummary(style: {
  visualLanguageGuidance: string;
  paletteGuidance: string;
  textureGuidance: string;
}): string {
  return [
    `Visual language: ${style.visualLanguageGuidance}`,
    `Palette: ${style.paletteGuidance}`,
    `Texture: ${style.textureGuidance}`,
  ].join("\n\n");
}

/**
 * Every continuity fact on record, grouped by the subject it's about — so a
 * location's, prop's or character's established facts sit together in the
 * bible, rather than in whatever order extraction happened to record them.
 */
function continuityFactsBySubject(db: Db, projectId: string): string {
  const facts = db.select().from(continuityFacts).where(eq(continuityFacts.projectId, projectId)).all();
  if (facts.length === 0) return "(no continuity facts recorded yet)";

  const bySubject = new Map<string, { subjectType: ContinuitySubjectType; subjectName: string; fact: string }[]>();
  for (const f of facts) {
    const key = `[${f.subjectType}] ${f.subjectName}`;
    const group = bySubject.get(key) ?? [];
    group.push(f);
    bySubject.set(key, group);
  }

  return [...bySubject.entries()]
    .map(([subject, group]) => `${subject}:\n${group.map((f) => `  - ${f.fact}`).join("\n")}`)
    .join("\n\n");
}

/**
 * Stage 14 — the capstone for Preproduction's aesthetic register. Assembles
 * one document from Production Design Style's guidance plus every approved
 * location/prop and continuity fact — exactly the same shape as
 * `runStoryBible` above: formatting already-approved material, not writing
 * new prose, so no provider is resolved and no `sd-api` call is made.
 *
 * Deliberately does not re-read `world_building`'s locations/props by way of
 * `worldSummary` (that helper condenses for a *text* prompt); this stage
 * wants the full name+description of each, since the visual bible is the one
 * place Preproduction's aesthetic guidance and the concrete inventory of
 * what has to be built/found/lit sit side by side. Continuity facts are
 * included and grouped by subject per the M7 detail page's own PR8 scope —
 * a production designer needs to know a prop's established look or a
 * location's established geography before deciding how to build or dress it.
 *
 * Left unapproved on write, like `story_bible` — the ordinary "approve and
 * continue" mechanism (chain.ts's `advance`) gates this, not a second
 * approval path invented just for an assembly stage.
 */
export async function runVisualBible(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const productionDesignStyle = requireProductionDesignStyle(bundle);

  const world = ctx.db.select().from(worldBuilding).where(eq(worldBuilding.projectId, projectId)).get();
  const locs = ctx.db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = ctx.db.select().from(props).where(eq(props.projectId, projectId)).all();

  const locationsSection =
    locs.length > 0 ? locs.map((l) => `- ${l.name}: ${l.description}`).join("\n") : "(none)";
  const propsSection = items.length > 0 ? items.map((p) => `- ${p.name}: ${p.description}`).join("\n") : "(none)";

  const content = [
    `# Production Design Style\n\n${productionDesignSummary(productionDesignStyle)}`,
    `# World Building\n\n${world?.content ?? "(no world-building notes yet)"}`,
    `# Locations\n\n${locationsSection}`,
    `# Props\n\n${propsSection}`,
    `# Continuity Facts\n\n${continuityFactsBySubject(ctx.db, projectId)}`,
  ].join("\n\n");

  ctx.progress(0.5);
  writeDevArtifact(ctx.db, projectId, "visual_bible", content, "", false);
  ctx.log("Visual bible assembled");
  ctx.progress(1);
}

/**
 * Stage 15 — the approved visual bible becomes a production-design document:
 * what needs building vs. finding, key texture/material choices, and a
 * lighting approach per location type — the brief a production designer
 * would hand an art department.
 *
 * Reads only the approved visual bible, not the raw locations/props/
 * continuity facts a second time — the bible (stage 14) is already
 * Preproduction's own condensed capstone for this register, so re-deriving
 * from its sources here would defeat the point of having assembled it.
 * Per finding F10's 4096-token cap: the bible is passed in full rather than
 * further condensed, a deliberate judgment call, not an oversight —
 * `runScriptBreakdown` already establishes that passing one condensed
 * capstone document whole is safe (it is `story_bible` alone, not
 * `story_bible` plus both breakdowns stacked on top of it, that blew the cap
 * in PR7's real run). The visual bible is built from Production Design
 * Style's three short guidance fields, `world_building`'s prose, and
 * locations/props/continuity facts — the same order of magnitude as
 * `worldSummary` plus `existingFactsSummary` combined, both already proven
 * safe elsewhere in this file — not the full concept-through-screenplay
 * stack `story_bible` itself carries. If a real run measures otherwise, the
 * fix is condensing the bible's own assembly (e.g. dropping continuity
 * facts with no bearing on a location/prop), not re-deriving from raw
 * sources here.
 *
 * "production_design" is currently the last stage `DEV_CHAIN_STAGES` names,
 * so — like `runContinuity` above — this stage does not hand off further in
 * auto mode.
 */
export async function runProductionDesign(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const productionDesignStyle = requireProductionDesignStyle(bundle);
  const provider = resolveDevProvider(ctx.db);

  const visualBible = requireDevArtifactContent(ctx.db, projectId, "visual_bible");
  const direction = pendingDirection(ctx);

  ctx.log(`Writing production design with ${provider.model}`);
  ctx.progress(0.2);
  checkAbort(ctx);

  const { content } = await ctx.llmClient(provider).chat({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.production_design", {
          visualBible,
          visualLanguageGuidance: productionDesignStyle.visualLanguageGuidance,
          paletteGuidance: productionDesignStyle.paletteGuidance,
          textureGuidance: productionDesignStyle.textureGuidance,
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.6,
  });

  writeDevArtifact(ctx.db, projectId, "production_design", content.trim(), direction, project.mode === "auto");
  ctx.log("Production design written");

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  // Deliberately does NOT `continueDevChain` into "concept_art", unlike every
  // other dev_artifacts generation stage above hand off to what's next in
  // auto mode. Image generation is the one CPU-bound stage in this whole
  // chain — ~65s/frame measured (finding F9) — and auto-chaining straight
  // from an LLM call into a run that can take minutes removes the only
  // natural pause point a user currently gets before something that
  // expensive starts. "continuity" set this precedent already, for a
  // different reason (facts need a human's eyes before the visual bible
  // trusts them) — this is the same non-auto-chaining choice for a different
  // one. The generic "continue" mechanism (chain.ts's `advance`) is what
  // starts "concept_art", same as it starts "visual_bible" after continuity.
  ctx.log("Production design written — advance to concept art next");
}

/**
 * Stage 17 (M7 PR9) — the first stage in this chain that generates
 * images rather than text: one concept-art image per location and per prop
 * that doesn't already have one.
 *
 * Scoped to locations/props only, per the M7 detail page's own stage list —
 * character identity-lock is stage 20 ("Casting"), not this one, and a
 * character's own portrait is Development's concern (stage 3's
 * `runDevCharacters`), not Preproduction's. That said: `runDevCharacters`
 * writes character rows with no `imageAssetId`/`appearanceTag`-driven
 * portrait generation of its own — a dev-format project's cast currently has
 * no portrait-generation path at all. That gap is real but out of this
 * stage's scope; it is not this stage's job to fill it.
 *
 * Reuses `runCharacterImages`'s exact shape: resumable (an entity that
 * already has an `imageAssetId` is skipped, so a run that dies partway
 * resumes rather than restarts), uploads the result as a reference the same
 * way (`backend.uploadReference`), and negative-prompts the same way
 * (`negativePromptFor`). Deliberately does NOT call `filterLiveRefs` here —
 * that function degrades a *consumer's* prompt when a reference it wants has
 * gone missing, and concept art doesn't consume any reference (it produces
 * one); it's PR10's storyboards that will call `filterLiveRefs` against
 * these rows, the same way `runSceneImages` already calls it against
 * `characters`.
 *
 * The prompt's register split (ADR 0002, and see this repo's own notes on
 * why getting it backwards here specifically is the costly mistake): the
 * entity's own `name`/`description` and Production Design Style's three
 * guidance fields are CONTENT — what is physically in the world, the same
 * category as a scene's `imagePrompt` describing what's in frame. Image
 * Style's `promptPrefix`/`promptSuffix` are the RENDERING register — film
 * stock, grade, lighting quality — and wrap the whole assembled content
 * exactly the way they wrap every other image-generation call in this
 * codebase (`runSceneImages`, `runCharacterImages`). Production Design
 * Style's guidance never touches the prefix/suffix, and Image Style's
 * guidance never enters the content templates below — mixing those two is
 * exactly the register-leak class of bug this project's Prompt & Flow Audit
 * flagged repeatedly.
 */
export async function runConceptArt(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project, imageStyle } = bundle;
  const productionDesignStyle = requireProductionDesignStyle(bundle);
  const imageProvider = resolveProvider(ctx.db, "image");
  const backend = ctx.imageBackend();

  // Content, not rendering — see this function's own doc comment. Folded
  // into comma-separated phrases because this prompt goes straight to the
  // diffusion model with no LLM in between (same discipline as
  // `character.portrait`'s own template comment), unlike `productionDesignSummary`
  // above, which formats the same three fields as prose for an LLM prompt.
  const guidance = [
    productionDesignStyle.visualLanguageGuidance,
    productionDesignStyle.paletteGuidance,
    productionDesignStyle.textureGuidance,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

  const locs = ctx.db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = ctx.db.select().from(props).where(eq(props.projectId, projectId)).all();

  // M7.1 PR-D0. A scoped redo names exactly one entity; `regenerate()` has
  // already cleared that row's image, so the ordinary "missing an image"
  // filter would find it anyway — but it would also pick up any *other* entity
  // still lacking one, which on this hardware is minutes per extra plate
  // (finding F9). Narrowing here is what makes a one-entity redo cost one
  // generation. Same shape as `runSceneImages`' own `jobSceneId` scoping.
  const jobLocationId =
    typeof ctx.job.payload.locationId === "string" ? ctx.job.payload.locationId : undefined;
  const jobPropId = typeof ctx.job.payload.propId === "string" ? ctx.job.payload.propId : undefined;
  const scoped = jobLocationId ?? jobPropId;

  // BUG-30. A re-roll's direction is CONTENT, not rendering: "make it dusk",
  // "more rust on the shutters" says what is physically in the plate, which is
  // the same register as the entity's own description and Production Design
  // Style's guidance. So it is appended to this template's output and stays
  // *inside* Image Style's promptPrefix/promptSuffix — those are the rendering
  // register and belong to the style, not to one job (ADR 0002, and this
  // function's own doc comment above). Same placement and same `, `-joined
  // shape `runCharacterImages` (images.ts) already uses for a scoped portrait
  // redo. No scope test is needed around it the way images.ts needs one: the
  // `pendingLocations`/`pendingProps` filters below already reduce a scoped
  // job to the single named entity, so an unscoped whole-stage redo carrying
  // direction applies it to every plate it draws, exactly as that stage does.
  const direction = pendingDirection(ctx);
  const directionPhrase = direction ? `, ${direction}` : "";

  const pendingLocations = locs.filter(
    (l) => !l.imageAssetId && (jobLocationId ? l.id === jobLocationId : !jobPropId),
  );
  const pendingProps = items.filter(
    (p) => !p.imageAssetId && (jobPropId ? p.id === jobPropId : !jobLocationId),
  );
  const total = pendingLocations.length + pendingProps.length;

  if (total === 0) {
    ctx.log("Every location/prop already has concept art");
  }

  let done = 0;
  for (const location of pendingLocations) {
    checkAbort(ctx);
    ctx.log(`Generating concept art for location "${location.name}" (${done + 1}/${total})`);

    const prompt =
      `${imageStyle.promptPrefix}` +
      renderPrompt(ctx.db, "concept_art.location", {
        subjectDescription: `${location.name}, ${location.description}`,
        productionDesignGuidance: guidance,
      }) +
      directionPhrase +
      `${imageStyle.promptSuffix}`;

    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: ctx.config.referenceImage.width,
        height: ctx.config.referenceImage.height,
        references: [],
      },
      {
        onProgress: (fraction) => ctx.progress((done + fraction) / Math.max(total, 1)),
        shouldAbort: ctx.shouldAbort,
        log: ctx.log,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `location-${location.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      meta: { locationId: location.id, prompt },
    });
    const refInputName = await backend.uploadReference(bytes, `${location.id}.png`);

    ctx.db
      .update(locations)
      .set({ imageAssetId: asset.id, refInputName })
      .where(eq(locations.id, location.id))
      .run();
    done++;
  }

  for (const prop of pendingProps) {
    checkAbort(ctx);
    ctx.log(`Generating concept art for prop "${prop.name}" (${done + 1}/${total})`);

    const prompt =
      `${imageStyle.promptPrefix}` +
      renderPrompt(ctx.db, "concept_art.prop", {
        subjectDescription: `${prop.name}, ${prop.description}`,
        productionDesignGuidance: guidance,
      }) +
      directionPhrase +
      `${imageStyle.promptSuffix}`;

    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: ctx.config.referenceImage.width,
        height: ctx.config.referenceImage.height,
        references: [],
      },
      {
        onProgress: (fraction) => ctx.progress((done + fraction) / Math.max(total, 1)),
        shouldAbort: ctx.shouldAbort,
        log: ctx.log,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `prop-${prop.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      meta: { propId: prop.id, prompt },
    });
    const refInputName = await backend.uploadReference(bytes, `${prop.id}.png`);

    ctx.db.update(props).set({ imageAssetId: asset.id, refInputName }).where(eq(props.id, prop.id)).run();
    done++;
  }

  ctx.log(total === 0 ? "No concept art needed" : `${total} concept art image(s) generated and uploaded as references`);

  // Same "no rich review UI yet" approval bar `continuity` already clears —
  // approval means "the generation pass ran (or had nothing to do) and a
  // human reached this point", not per-image sign-off, since no UI for that
  // exists yet.
  //
  // A scoped redo is not the project reaching this stage, so it must not
  // restate the stage's approval either way — see the note in `runElements`
  // that `runSceneImages` follows for the same reason. Re-approving would
  // rubber-stamp a stage a human may never have reviewed; un-approving would
  // send an already-approved project back to a gate it had cleared, and (in
  // manual mode) park it for review over one re-rolled plate.
  if (!scoped) {
    ctx.db
      .update(projects)
      .set({ conceptArtApprovedAt: project.mode === "auto" ? new Date() : null })
      .where(eq(projects.id, projectId))
      .run();
  }

  if (scoped) {
    ctx.log("Concept art re-rolled for one entity");
    return;
  }
  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  // Deliberately does NOT `continueDevChain` into "storyboards", same reason
  // `runProductionDesign` doesn't auto-chain into this stage: storyboards is
  // itself image generation (per-panel, and a scene breakdown can have many
  // beats — finding F9's CPU-bound cost applies just as much here as it did
  // to concept art). The generic "continue" mechanism starts it.
  ctx.log("Concept art written — advance to storyboards next");
}

/**
 * How many reference images one storyboard panel may carry.
 *
 * Measured, not guessed (finding F30): reference conditioning costs roughly
 * 130s per reference at 512x768 on this CPU box, and sd-api enforces its own
 * `SD_JOB_TIMEOUT_MS` (default 600s) well below viceroy's 30-minute
 * `SD_API_TIMEOUT_MS` — so the remote cap is the binding one. Three references
 * land at ~406s; four project to ~540s and five to ~670s, which does not run
 * slowly, it fails outright.
 *
 * Three is therefore a ceiling imposed by the host, not a quality judgment.
 * F30 also measured that references 2 and 3 both contribute materially (the
 * third is what pulls a panel onto the locked location instead of an invented
 * one), so this budget is spent, not conserved.
 */
export const PANEL_REFERENCE_BUDGET = 3;

/**
 * Pick which entities anchor one panel, in priority order, within the budget.
 *
 * Tiers are consulted in order and the budget is spent greedily, so the
 * caller's tier ordering *is* the priority: cast first, then location, then
 * prop. Identity is what drifts most visibly between adjacent panels and is
 * what a viewer notices, so it gets the slots before set dressing does.
 *
 * Matching stays the same case-insensitive substring check over the beat's
 * description that this stage already used for locations and props — good
 * enough to tell which entities a beat is about, without a second LLM
 * extraction pass purely to name them. Its one known weakness is inherited: a
 * beat that refers to a character obliquely ("the old man") rather than by
 * name matches nothing and generates unanchored, which is the pre-existing
 * behaviour for locations and props too.
 *
 * The Project Look Pack is deliberately absent from these tiers. It stays
 * textual — Production Design Style's guidance fields are already concatenated
 * into every panel prompt below — because a reference slot buys far more spent
 * on identity than on style glue, and `ImageRequest` references carry no
 * per-reference weight that a "low strength" style anchor would need anyway.
 */
export function selectPanelReferences(
  beatDescription: string,
  tiers: readonly { entities: readonly { id: string; name: string }[]; live: Map<string, string> }[],
  budget: number,
): string[] {
  const haystack = beatDescription.toLowerCase();
  const chosen: string[] = [];

  for (const tier of tiers) {
    for (const entity of tier.entities) {
      if (chosen.length >= budget) return chosen;
      if (!haystack.includes(entity.name.toLowerCase())) continue;
      const ref = tier.live.get(entity.id);
      // Two entities can share one uploaded reference only by accident, but a
      // duplicate would waste a scarce slot on nothing, so it is skipped.
      if (ref && !chosen.includes(ref)) chosen.push(ref);
    }
  }
  return chosen;
}

/**
 * Load every character's live reference-pack views, keyed by character.
 *
 * Liveness is checked per view, not per character: `refInputName` points at
 * state in another service, so one view's upload can go missing while the rest
 * survive. A view that has gone is dropped from the map and
 * `resolveCastReference` falls past it — the same degrade-don't-fail rule
 * `filterLiveRefs` applies to characters, locations and props (ADR 0001).
 */
export async function livePackViews(
  backend: Pick<ImageBackend, "hasReference">,
  rows: {
    characterId: string;
    view: CrpView;
    refInputName: string | null;
    wardrobeVariantId?: string | null;
  }[],
): Promise<Map<string, Map<string, string>>> {
  const candidates = rows.filter((row): row is typeof row & { refInputName: string } =>
    Boolean(row.refInputName),
  );
  const alive = await Promise.all(candidates.map((row) => backend.hasReference(row.refInputName)));

  const byCharacter = new Map<string, Map<string, string>>();
  candidates.forEach((row, index) => {
    if (!alive[index]) return;
    const views = byCharacter.get(row.characterId) ?? new Map<string, string>();
    views.set(packKey(row.view, row.wardrobeVariantId ?? null), row.refInputName);
    byCharacter.set(row.characterId, views);
  });
  return byCharacter;
}

/**
 * How a pack view is addressed once outfits exist (M7.1 PR-C).
 *
 * A wardrobe-independent view is keyed by name alone; a body view is keyed by
 * name and variant, because one character legitimately has several. Mirrors
 * migration 0022's `ifnull(wardrobe_variant_id,'')` uniqueness so the in-memory
 * key and the database constraint cannot disagree about what "the same view"
 * means.
 */
export function packKey(view: CrpView, wardrobeVariantId: string | null): string {
  return isWardrobeDependent(view) ? `${view}::${wardrobeVariantId ?? ""}` : view;
}

/**
 * Pick the pack view that best matches this shot, or fall back to the anchor.
 *
 * See `crpViewPreference` for why matching framing matters. `fallback` is the
 * character's own `characters.refInputName` — every locked character has one,
 * and a project cast before M7.1 PR-B existed has *only* that, so this returns
 * exactly the pre-pack behaviour for them rather than nothing.
 */
export function resolveCastReference(
  pack: Map<string, string> | undefined,
  fallback: string | undefined,
  shotType: StoryboardShotType,
  wardrobe: { variantId: string | null; defaultVariantId: string | null } = {
    variantId: null,
    defaultVariantId: null,
  },
): string | undefined {
  for (const view of crpViewPreference(shotType)) {
    if (!isWardrobeDependent(view)) {
      const ref = pack?.get(view);
      if (ref) return ref;
      continue;
    }
    // A body view is tried against the panel's named outfit first, then the
    // character's default. Falling back matters: a panel can name a variant
    // belonging to a *different* character, in which case this character has
    // no view under that id and should wear their own default rather than
    // dropping out of the reference set entirely.
    for (const variantId of [wardrobe.variantId, wardrobe.defaultVariantId, null]) {
      const ref = pack?.get(packKey(view, variantId));
      if (ref) return ref;
    }
  }
  return fallback;
}

/**
 * Stage 18 (M7 PR10) — one storyboard panel per beat in the approved scene
 * breakdown, each with its own independently-editable shotType/cameraAngle/
 * cameraMovement/lens rather than one prose paragraph — the structured
 * cinematography fields the M7 detail page's Style-system section scoped
 * ahead of time, once "scenes exist in Preproduction" (they do, as of
 * `scene_breakdown`).
 *
 * Beat extraction is an LLM call (`chatJson`) rather than a parser over
 * `scene_breakdown`'s own "SCENE <n>" headers — the same "turn prose into
 * structured rows" choice `runContinuity`'s own extraction and elements.ts's
 * cast/beat extraction already make. A parser keyed to the literal "SCENE
 * <n>" / blank-line format would also only ever produce one panel per scene,
 * never per beat, since nothing in that document's own structure marks where
 * a busy scene's visually distinct beats fall — deciding that split is
 * exactly the kind of judgment call an extraction pass, not a regex, is
 * suited to. See `dev.storyboards`'s own prompt for what a "beat" means here.
 *
 * Reuses `runConceptArt`'s image-generation shape (resumable, `storeAsset`,
 * the same register split: the beat's own visual content and Production
 * Design Style's guidance are CONTENT; Image Style's prefix/suffix are the
 * RENDERING register), and anchors each panel to the canon a human already
 * approved: a beat whose text names a known character, location or prop gets
 * that entity's uploaded reference passed as `references`, the same way
 * `runSceneImages` (images.ts) references character portraits.
 *
 * The cast half of that is M7.1 PR-A2, and it is the reason this milestone
 * exists. M7 PR10 shipped this stage referencing `locations`/`props` only,
 * because casting sat at stage 20 — *after* storyboards — so no character had
 * a portrait to reference yet. Every face in every panel was therefore
 * unconditioned prompt text, with finding F14 ruling out even naming the
 * character in that text. PR-A moved casting to stage 16 so the portraits
 * exist by the time this runs; this stage now spends its reference budget on
 * them first. See `selectPanelReferences` above for the priority order and
 * `PANEL_REFERENCE_BUDGET` for why it is capped at three.
 *
 * Resumable per panel, matched by (projectId, sceneId, index): a beat whose
 * row already carries a `panelImageAssetId` is skipped, the same "a crash
 * partway through costs one frame, not the whole run" shape
 * `runConceptArt`/`runSceneImages` already have. Beat extraction itself
 * re-runs every call — it is comparatively cheap next to image generation
 * (finding F9), and the alternative (caching the beat list) would need its
 * own invalidation story for a `scene_breakdown` redo that this stage's
 * `DISCARD` entry doesn't currently track separately.
 */
export async function runStoryboards(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project, imageStyle } = bundle;
  const productionDesignStyle = requireProductionDesignStyle(bundle);
  const provider = resolveDevProvider(ctx.db);
  const imageProvider = resolveProvider(ctx.db, "image");
  const backend = ctx.imageBackend();

  const sceneBreakdown = requireDevArtifactContent(ctx.db, projectId, "scene_breakdown");
  const direction = pendingDirection(ctx);

  // A panel becomes a shot-list keyframe and reaches the previs render, so it
  // takes the project's own frame shape (M7.1 PR-E) rather than the global
  // default that had movie projects drawing portrait panels.
  const panelSize = sourceImageFor(ctx.config, projectAspect(project));

  // M7.1 PR-A's gate. `devNextStep` already walks `DEV_CHAIN_STAGES` in order
  // and so will not *offer* storyboards before casting is locked, but a direct
  // redo can name this stage outright — and a panel generated against an
  // unlocked cast is exactly the drift this milestone exists to stop, with no
  // cheap way to tell after the fact which panels were anchored and which were
  // not. Same discipline as the cast-lock check in `regenerate()`
  // (lib/projects.ts): a client-side warning alone is not a guard.
  const unlocked = ctx.db
    .select({ name: characters.name })
    .from(characters)
    .where(and(eq(characters.projectId, projectId), isNull(characters.castingLockedAt)))
    .all();
  if (unlocked.length > 0) {
    throw new Error(
      `Casting is not locked for ${unlocked.map((c) => c.name).join(", ")} — ` +
        `run the casting stage before storyboards, so panels can be anchored to their portraits`,
    );
  }

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const locs = ctx.db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = ctx.db.select().from(props).where(eq(props.projectId, projectId)).all();
  const liveCastRefs = await filterLiveRefs(backend, cast, ctx.log);
  const liveLocationRefs = await filterLiveRefs(backend, locs, ctx.log);
  const livePropRefs = await filterLiveRefs(backend, items, ctx.log);

  // A workflow exposes a fixed number of reference slots and the host imposes
  // its own wall-clock ceiling; the panel budget is whichever binds first.
  // Same `referenceCapacity()` convention `runSceneImages` (images.ts) already
  // follows for a crowded scene.
  const refBudget = Math.min(PANEL_REFERENCE_BUDGET, backend.referenceCapacity());
  if (refBudget < PANEL_REFERENCE_BUDGET) {
    ctx.log(
      `${backend.label} exposes ${backend.referenceCapacity()} reference slot(s) — ` +
        `panels will be anchored with at most that many, not ${PANEL_REFERENCE_BUDGET}`,
      "warn",
    );
  }

  // M7.1 PR-B. The cast tier's reference depends on the shot being drawn — a
  // close-up wants a head view, a wide wants the full figure — so unlike
  // locations and props it cannot be one fixed map for the whole stage. The
  // pack is loaded and liveness-checked once here; `castTierFor` below picks
  // per panel.
  const packRows =
    cast.length > 0
      ? ctx.db
          .select()
          .from(characterReferenceImages)
          .where(
            inArray(
              characterReferenceImages.characterId,
              cast.map((c) => c.id),
            ),
          )
          .all()
      : [];
  const packs = await livePackViews(backend, packRows);

  // M7.1 PR-C. A panel's `wardrobeVariantId` names one character's outfit; every
  // other character in it wears their own default, which is what this map
  // supplies.
  const defaultVariantByCharacter = new Map(
    (cast.length > 0
      ? ctx.db
          .select()
          .from(wardrobeVariants)
          .where(
            inArray(
              wardrobeVariants.characterId,
              cast.map((c) => c.id),
            ),
          )
          .all()
      : []
    )
      .filter((variant) => variant.isDefault)
      .map((variant) => [variant.characterId, variant.id] as const),
  );

  const castTierFor = (shotType: StoryboardShotType, wardrobeVariantId: string | null) => {
    const live = new Map<string, string>();
    for (const character of cast) {
      const ref = resolveCastReference(
        packs.get(character.id),
        liveCastRefs.get(character.id),
        shotType,
        {
          variantId: wardrobeVariantId,
          defaultVariantId: defaultVariantByCharacter.get(character.id) ?? null,
        },
      );
      if (ref) live.set(character.id, ref);
    }
    return { entities: cast, live };
  };

  const setTiers = [
    { entities: locs, live: liveLocationRefs },
    { entities: items, live: livePropRefs },
  ];

  // M7.1 PR-D0 — re-roll one panel, without re-extracting beats.
  //
  // Beat extraction is skipped deliberately, not just as an economy. This
  // stage re-runs extraction on every ordinary call and matches results back
  // to rows by (projectId, sceneId, index) — fine when regenerating the whole
  // set, but a fresh extraction is an LLM call at temperature 0.4 and may not
  // produce a beat at this panel's coordinates at all. The redo would then
  // regenerate some *other* panel, or none, while reporting success. The row
  // already carries everything a re-roll needs: its assembled prompt and its
  // cinematography fields, both of which a human may have edited since.
  //
  // References are matched against the stored prompt rather than a beat
  // description, the same way `runShotList` reads `panelImagePrompt` to find
  // which cast members a panel is about — the prompt contains the description.
  const jobPanelId = typeof ctx.job.payload.panelId === "string" ? ctx.job.payload.panelId : undefined;
  if (jobPanelId) {
    const panel = ctx.db
      .select()
      .from(storyboardPanels)
      .where(and(eq(storyboardPanels.id, jobPanelId), eq(storyboardPanels.projectId, projectId)))
      .get();
    if (!panel) throw new Error(`No such storyboard panel on this project: ${jobPanelId}`);

    const prompt = `${panel.panelImagePrompt}${direction ? `, ${direction}` : ""}`;
    const refs = selectPanelReferences(
      panel.panelImagePrompt,
      [castTierFor(panel.shotType, panel.wardrobeVariantId), ...setTiers],
      refBudget,
    );
    ctx.log(
      `Re-rolling storyboard panel for scene ${panel.sceneId}, beat ${panel.index + 1} ` +
        `with ${refs.length} reference(s)`,
    );

    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: panelSize.width,
        height: panelSize.height,
        references: refs,
      },
      { onProgress: ctx.progress, shouldAbort: ctx.shouldAbort, log: ctx.log },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `storyboard-scene${panel.sceneId}-${String(panel.index).padStart(3, "0")}`,
      meta: { sceneId: panel.sceneId, index: panel.index, prompt },
    });

    // `panelImagePrompt` is rewritten only when direction was given, so an
    // undirected re-roll leaves the stored prompt exactly as a human left it.
    ctx.db
      .update(storyboardPanels)
      .set({ panelImageAssetId: asset.id, ...(direction ? { panelImagePrompt: prompt } : {}) })
      .where(eq(storyboardPanels.id, panel.id))
      .run();

    // No `storyboardsApprovedAt` write, for the reason `runConceptArt`'s own
    // scoped path gives: one re-rolled panel is not the project reaching or
    // leaving this stage.
    ctx.log("Storyboard panel re-rolled");
    return;
  }

  ctx.log(`Extracting storyboard beats with ${provider.model}`);
  ctx.progress(0.05);
  checkAbort(ctx);

  const payload = await ctx.llmClient(provider).chatJson<StoryboardBeatsPayload>({
    model: provider.model,
    messages: [
      {
        role: "user",
        content: renderPrompt(ctx.db, "dev.storyboards", {
          sceneBreakdown,
          castSummary: castSummary(ctx.db, projectId),
          worldSummary: worldSummary(ctx.db, projectId),
          direction: directionBlock(direction),
          groundingInstruction: groundingInstruction(project),
        }),
      },
    ],
    temperature: 0.4,
  });

  const beats = (payload.beats ?? [])
    .filter(
      (b): b is StoryboardBeatCandidate & { sceneId: string; description: string } =>
        typeof b?.sceneId === "string" &&
        b.sceneId.trim().length > 0 &&
        typeof b?.description === "string" &&
        b.description.trim().length > 0,
    )
    .map((b, i) => ({
      sceneId: b.sceneId.trim(),
      description: b.description.trim(),
      shotType: coerceVocab(b.shotType, STORYBOARD_SHOT_TYPES, "medium"),
      cameraAngle: coerceVocab(b.cameraAngle, STORYBOARD_CAMERA_ANGLES, "eye-level"),
      cameraMovement: coerceVocab(b.cameraMovement, STORYBOARD_CAMERA_MOVEMENTS, "static"),
      lens: coerceVocab(b.lens, STORYBOARD_LENSES, "standard"),
      index: i,
    }));

  if (beats.length === 0) {
    throw new Error(`Project ${projectId} — storyboard beat extraction returned no usable beats`);
  }

  // Content, not rendering — same discipline `runConceptArt` already applies
  // to these same three fields.
  const guidance = [
    productionDesignStyle.visualLanguageGuidance,
    productionDesignStyle.paletteGuidance,
    productionDesignStyle.textureGuidance,
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(", ");

  const existing = ctx.db
    .select()
    .from(storyboardPanels)
    .where(eq(storyboardPanels.projectId, projectId))
    .all();
  const existingByKey = new Map(existing.map((p) => [`${p.sceneId}::${p.index}`, p]));

  const pending = beats.filter((beat) => {
    const row = existingByKey.get(`${beat.sceneId}::${beat.index}`);
    return !row?.panelImageAssetId;
  });

  if (pending.length === 0) {
    ctx.log("Every storyboard beat already has a panel");
  }

  let done = 0;
  for (const beat of pending) {
    checkAbort(ctx);

    // Cast first, then location, then prop — see `selectPanelReferences`.
    const refs = selectPanelReferences(
      beat.description,
      [castTierFor(beat.shotType, existingByKey.get(`${beat.sceneId}::${beat.index}`)?.wardrobeVariantId ?? null), ...setTiers],
      refBudget,
    );

    // The reference count is worth logging per panel, not just per stage: it is
    // the one number that says whether this panel was anchored to canon or
    // generated from prompt text alone, and F30 makes it the dominant term in
    // how long the panel will take.
    ctx.log(
      `Generating storyboard panel for scene ${beat.sceneId}, beat ${beat.index + 1} ` +
        `(${done + 1}/${pending.length}) with ${refs.length} reference(s)`,
    );

    const shotDescriptor = [
      `${beat.shotType} shot`,
      `${beat.cameraAngle} angle`,
      `${beat.cameraMovement} camera`,
      `${beat.lens} lens`,
    ].join(", ");

    const prompt =
      `${imageStyle.promptPrefix}` +
      renderPrompt(ctx.db, "storyboard.panel", {
        shotDescriptor,
        subjectDescription: beat.description,
        productionDesignGuidance: guidance,
      }) +
      `${imageStyle.promptSuffix}`;

    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        // `sourceImage`, not `referenceImage` (M7.1 PR-A3): a panel is not only
        // conditioning material. `runShotList` defaults each shot's
        // `keyframeAssetId` to the panel's own image, and `runPrevis` renders
        // those keyframes at the project's video dimensions — so a panel's
        // aspect reaches the animatic, and has to stay locked to the output the
        // way every other rendered frame is.
        width: panelSize.width,
        height: panelSize.height,
        references: refs,
      },
      {
        onProgress: (fraction) => ctx.progress((done + fraction) / Math.max(pending.length, 1)),
        shouldAbort: ctx.shouldAbort,
        log: ctx.log,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `storyboard-scene${beat.sceneId}-${String(beat.index).padStart(3, "0")}`,
      meta: { sceneId: beat.sceneId, index: beat.index, prompt },
    });

    const row = existingByKey.get(`${beat.sceneId}::${beat.index}`);
    const values = {
      panelImagePrompt: prompt,
      shotType: beat.shotType,
      cameraAngle: beat.cameraAngle,
      cameraMovement: beat.cameraMovement,
      lens: beat.lens,
      panelImageAssetId: asset.id,
    };
    if (row) {
      ctx.db.update(storyboardPanels).set(values).where(eq(storyboardPanels.id, row.id)).run();
    } else {
      ctx.db
        .insert(storyboardPanels)
        .values({ projectId, sceneId: beat.sceneId, index: beat.index, ...values })
        .run();
    }
    done++;
  }

  ctx.log(
    pending.length === 0 ? "No storyboard panels needed" : `${done} storyboard panel(s) generated`,
  );

  // Same "no rich review UI yet" approval bar `concept_art` already clears —
  // approval means "the generation pass ran (or had nothing to do) and a
  // human reached this point", not per-panel sign-off (finding F9: this can
  // be the most expensive stage yet, one panel per beat across every scene).
  ctx.db
    .update(projects)
    .set({ storyboardsApprovedAt: project.mode === "auto" ? new Date() : null })
    .where(eq(projects.id, projectId))
    .run();

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  ctx.log("Storyboard panels written — advance to the shot list next");
}

type StoryboardBeatCandidate = {
  sceneId?: unknown;
  description?: unknown;
  shotType?: unknown;
  cameraAngle?: unknown;
  cameraMovement?: unknown;
  lens?: unknown;
};
type StoryboardBeatsPayload = { beats?: StoryboardBeatCandidate[] };

/**
 * Coerce a model-supplied field value into one of a fixed vocabulary,
 * defaulting rather than failing the stage over one malformed field — the
 * same graceful-degradation posture `resolveSubject`'s dangling-reference
 * handling above already takes, just for a closed enum instead of a lookup.
 * Normalizes case and internal whitespace/underscores to hyphens first
 * ("Close Up", "close_up" -> "close-up") since a model asked for one of a
 * few fixed strings drifts in formatting more often than in substance.
 */
function coerceVocab<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-") as T;
    if ((allowed as readonly string[]).includes(normalized)) return normalized;
  }
  return fallback;
}

type ShotListRefinement = {
  keyframePrompt?: unknown;
  motionPrompt?: unknown;
  durationHintMs?: unknown;
  /** M7.2 — 1-based indices into the scene's own numbered line list. */
  dialogueLines?: unknown;
};

/**
 * The lines the model picked, resolved back to the authored text (M7.2).
 *
 * Indices, never strings: the model is asked which lines this shot covers, not
 * to reproduce them, so there is no path by which a reworded or hallucinated
 * line reaches the row. That is what lets a caption stay authored text after
 * LTX speaks it, rather than becoming a transcription of whatever came out —
 * the distinction findings F1 and F5 are about.
 */
function selectDialogueLines(available: DialogueLine[], picked: unknown): DialogueLine[] {
  if (!Array.isArray(picked) || available.length === 0) return [];
  const seen = new Set<number>();
  const chosen: DialogueLine[] = [];
  for (const raw of picked) {
    const index = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(index) || index < 1 || index > available.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);
    chosen.push(available[index - 1]!);
  }
  // Screenplay order, whatever order the model listed them in — a shot plays
  // its lines in the order they were written.
  return chosen.sort((a, b) => available.indexOf(a) - available.indexOf(b));
}

// A plausible default for one shot's screen time when the model's own
// estimate is missing or nonsensical — sits mid-range of the prompt's own
// "typically 2000-6000ms" guidance, not at either edge, so a bad estimate
// degrades to something a previs animatic can still cut on rather than to a
// value that reads as broken (a 0ms or 60000ms shot).
//
// Imported rather than redeclared (M7.2): `runPrevis` and the production
// timeline both fall back to this same number, so the animatic's length and
// the timeline's total are the same by construction. They used to be three
// literals that happened to agree.
const DEFAULT_SHOT_DURATION_MS = DEFAULT_SEGMENT_DURATION_MS;
const MIN_SHOT_DURATION_MS = 1000;
const MAX_SHOT_DURATION_MS = 15_000;

/** Clamp a model-supplied duration estimate into a sane range, defaulting on anything unusable. */
function coerceDurationHintMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SHOT_DURATION_MS;
  return Math.round(Math.min(MAX_SHOT_DURATION_MS, Math.max(MIN_SHOT_DURATION_MS, value)));
}

/**
 * Stage 19 (M7 PR11) — one `shot_list_items` row per approved storyboard
 * panel, refining that panel's own flat `panelImagePrompt` into the two
 * registers a shot actually needs: `keyframePrompt` (what the frame looks
 * like) and `motionPrompt` (what happens over its duration) — the same split
 * M8's own "Prompt engine" section specifies for its `shots` table, so a shot
 * list is ready to seed `shots` unchanged once a project commits to the
 * `film` pipeline (M8 PR1's fork). See `shotListItems`'s own comment in
 * lib/db/schema.ts for why this is a new table rather than a shared one —
 * that data-model question was already settled by the M7 detail page before
 * this PR started, not decided here.
 *
 * One LLM call per panel, not one call for the whole storyboard — each
 * refinement only needs its own panel's prompt plus its own cinematography
 * fields as input (see `dev.shot_list`'s own narrow-input discipline,
 * finding F10), and per-panel calls are what makes this stage resumable the
 * same way `runStoryboards`/`runConceptArt` are: a crash partway through
 * costs one row, not the whole run.
 *
 * Reuses `runStoryboards`' own simple case-insensitive name-matching
 * heuristic for `characterIds` — matched against the panel's own
 * `panelImagePrompt` (which already carries the beat's visual content that
 * produced it), not a second extraction pass to name which cast members a
 * shot "is about".
 *
 * Deliberately does NOT generate a new image: `keyframeAssetId` defaults to
 * the source panel's own `panelImageAssetId` — the panel IS effectively a
 * keyframe already, so this stage only refines text/metadata around the
 * image that exists, the same "no new inference where an existing artifact
 * already serves" call `runShotList`'s own doc comment on `keyframeAssetId`
 * (schema.ts) already makes.
 *
 * Resumable per item, matched by (projectId, sceneId, index): an item that
 * already exists for a given panel is skipped — chain order already
 * guarantees "storyboards" is approved by the time this stage runs, so every
 * panel it reads has a `panelImageAssetId`.
 *
 * Deliberately does NOT `continueDevChain` into "previs", the same reason
 * `runProductionDesign`/`runConceptArt` don't auto-chain into the
 * image-generation stage that follows them: previs is a full Remotion render
 * (finding F9's CPU-bound cost applies at least as much here as it does to a
 * single frame), so auto-chaining straight from a text-refinement pass into
 * a render removes the only natural pause point a user gets before it
 * starts. The generic "continue" mechanism (chain.ts's `advance`) is what
 * starts "previs", same as it starts every other stage this pattern applies
 * to.
 */
export async function runShotList(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;
  const provider = resolveDevProvider(ctx.db);
  const direction = pendingDirection(ctx);

  const panels = ctx.db
    .select()
    .from(storyboardPanels)
    .where(eq(storyboardPanels.projectId, projectId))
    .orderBy(asc(storyboardPanels.index))
    .all();
  if (panels.length === 0) {
    throw new Error(`Project ${projectId} has no storyboard panels to build a shot list from`);
  }

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();

  // M7.2. The revised screenplay is the authored source of every spoken word;
  // without this, dialogue died here and a finished movie reached Production
  // mute. Parsed once per run rather than per panel — one screenplay, many
  // panels.
  const sceneDialogue = extractSceneDialogue(
    requireDevArtifactContent(ctx.db, projectId, "screenplay_revision"),
  );

  const existing = ctx.db.select().from(shotListItems).where(eq(shotListItems.projectId, projectId)).all();
  const existingByKey = new Set(existing.map((row) => `${row.sceneId}::${row.index}`));

  const pending = panels.filter((panel) => !existingByKey.has(`${panel.sceneId}::${panel.index}`));

  if (pending.length === 0) {
    ctx.log("Every storyboard panel already has a shot list item");
  }

  let done = 0;
  for (const panel of pending) {
    checkAbort(ctx);
    ctx.log(
      `Refining shot list item for scene ${panel.sceneId}, panel ${panel.index + 1} (${done + 1}/${pending.length})`,
    );

    const shotDescriptor = [
      `${panel.shotType} shot`,
      `${panel.cameraAngle} angle`,
      `${panel.cameraMovement} camera`,
      `${panel.lens} lens`,
    ].join(", ");

    const available = resolveSpeakers(sceneDialogueFor(sceneDialogue, panel.sceneId), cast);
    const dialogueBlock =
      available.length === 0
        ? ""
        : [
            "",
            `Spoken lines in this scene (choose which belong to this shot, by number):`,
            ...available.map(
              (entry, i) => `${i + 1}. ${entry.characterName}: "${entry.line}"`,
            ),
          ].join("\n");

    const payload = await ctx.llmClient(provider).chatJson<ShotListRefinement>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "dev.shot_list", {
            storyboardPanelPrompt: panel.panelImagePrompt,
            shotDescriptor,
            sceneDialogue: dialogueBlock,
            direction: directionBlock(direction),
          }),
        },
      ],
      temperature: 0.4,
    });

    const keyframePrompt = typeof payload.keyframePrompt === "string" ? payload.keyframePrompt.trim() : "";
    const motionPrompt = typeof payload.motionPrompt === "string" ? payload.motionPrompt.trim() : "";
    if (!keyframePrompt || !motionPrompt) {
      throw new Error(
        `Project ${projectId} — shot list refinement for scene ${panel.sceneId}, panel ${panel.index} ` +
          `did not return both a keyframePrompt and a motionPrompt`,
      );
    }

    // Same simple name-mention heuristic `runStoryboards` uses for
    // locations/props, applied here against the cast instead — see this
    // function's own doc comment.
    const mentioned = cast.filter((c) => panel.panelImagePrompt.toLowerCase().includes(c.name.toLowerCase()));

    const dialogue = selectDialogueLines(available, payload.dialogueLines);

    ctx.db
      .insert(shotListItems)
      .values({
        projectId,
        sceneId: panel.sceneId,
        index: panel.index,
        keyframePrompt,
        motionPrompt,
        shotType: panel.shotType,
        cameraAngle: panel.cameraAngle,
        cameraMovement: panel.cameraMovement,
        lens: panel.lens,
        characterIds: mentioned.map((c) => c.id),
        dialogue,
        // A shot that carries speech cannot be shorter than the speech. The
        // model's own estimate is made without knowing how many words it has
        // to fit — it is asked for dramatic length, not for arithmetic — so
        // the floor is applied here rather than trusted to the prompt (M7.2).
        durationHintMs: Math.max(coerceDurationHintMs(payload.durationHintMs), minimumDurationMs(dialogue)),
        keyframeAssetId: panel.panelImageAssetId,
      })
      .run();
    done++;
  }

  ctx.log(pending.length === 0 ? "No shot list items needed" : `${done} shot list item(s) written`);

  // Same "the pass ran (or had nothing to do) and a human reached this
  // point" approval bar `storyboardsApprovedAt` already clears — no
  // per-item review UI exists yet.
  ctx.db
    .update(projects)
    .set({ shotListApprovedAt: project.mode === "auto" ? new Date() : null })
    .where(eq(projects.id, projectId))
    .run();

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  ctx.log("Shot list written — advance to previs next");
}

/**
 * Stage 16 (M7 PR12, moved there by M7.1 PR-A) — "Casting": generate the portrait a dev-format
 * project's cast has never had, then lock each character's identity.
 *
 * PR9 deliberately scoped concept art to locations/props only and left a
 * dev-format cast with no portrait-generation path at all — `runDevCharacters`
 * (stage 3) writes `name`/`description`/`arc` but never an `imageAssetId`.
 * That gap is closed here, in the place the M7 detail page's own "Casting"
 * section already named for it: "finalizing each character's visual
 * reference... as a formal gate" requires generating the reference before it
 * can be locked, so generation and lock are one coherent stage rather than
 * two separately-numbered PRs.
 *
 * Reuses `runCharacterImages`' exact generation shape (lib/pipeline/images.ts)
 * — same prompt assembly (Image Style's prefix/suffix wrapping the
 * `character.portrait` template rendered from `appearanceTag`, never
 * `description`, for the same reason that function's own doc comment gives),
 * same `backend.generate()`/`storeAsset`/`uploadReference()` sequence — but
 * with this chain's own tail (nothing auto-chains past an image-generation
 * stage per finding F9, same as `runConceptArt`/`runStoryboards`), not the
 * narrative pipeline's `setStage`/`enqueue("voiceover")`.
 *
 * Unlike every other table-stage above, there is no separate approval click:
 * a character is locked the moment its own portrait exists, in the same loop
 * iteration that generated it — "approved" (`devStageStatus`) simply means
 * every character has `castingLockedAt` set, the way "previs" means
 * `previsAssetId` is set. This is the mechanism the M7 detail page's
 * "Casting" section already committed to: locking IS the stage completing,
 * not a draft awaiting a separate sign-off. What a locked character then
 * gates is a redo, not this stage's own first pass — see `regenerate()`'s
 * casting-lock guard and `unlockCasting` in lib/projects.ts.
 *
 * Resumable per character (an `imageAssetId` already set is skipped) and
 * per-character scoped via `payload.characterId`, the same "redo one
 * portrait" shape `character_images` already has — used by a locked
 * character's redo once it has been explicitly unlocked.
 */
/**
 * How each reference-pack view is framed, and whether it needs a body crop.
 *
 * Code-side structured vocabulary folded into one editable template, the same
 * shape `runStoryboards`' own `shotDescriptor` uses for its four cinematography
 * fields — the phrasing per view is a fixed mapping, not something to restate
 * in free text (the M7.1 plan's "deterministic prompt compiler" point).
 *
 * `head_front` is absent deliberately: it is the anchor, built by
 * `character.portrait` rather than `character.reference_view`, because it is
 * the one view with no reference image to condition on and so has to carry the
 * whole identity by description alone.
 */
const CRP_VIEW_SPECS: Record<Exclude<CrpView, "head_front">, {
  framing: string;
  detail: string;
  body: boolean;
}> = {
  head_three_quarter: {
    framing: "three-quarter view head-and-shoulders portrait, head turned about 45 degrees",
    detail: "neutral expression, full face clearly visible and unobstructed",
    body: false,
  },
  head_side: {
    framing: "exact side profile head-and-shoulders portrait, head turned 90 degrees",
    detail: "neutral expression, clean profile silhouette",
    body: false,
  },
  body_front: {
    framing: "full figure standing straight facing camera, head to feet entirely in frame",
    detail: "arms relaxed at sides, neutral expression, complete outfit clearly visible",
    body: true,
  },
  body_side: {
    framing: "full figure standing straight in side profile, head to feet entirely in frame",
    detail: "arms relaxed at sides, complete outfit clearly visible",
    body: true,
  },
  expression_smiling: {
    framing: "tightly cropped head-and-shoulders portrait, face fills most of the frame",
    detail: "smiling warmly, facing camera, full face clearly visible",
    body: false,
  },
  expression_angry: {
    framing: "tightly cropped head-and-shoulders portrait, face fills most of the frame",
    detail: "angry, brows drawn down, facing camera, full face clearly visible",
    body: false,
  },
  expression_sad: {
    framing: "tightly cropped head-and-shoulders portrait, face fills most of the frame",
    detail: "sad, downcast, facing camera, full face clearly visible",
    body: false,
  },
};

/** Every pack view except the anchor, in `CRP_VIEWS` order. */
const CRP_DERIVED_VIEWS = CRP_VIEWS.filter(
  (view): view is Exclude<CrpView, "head_front"> => view !== "head_front",
);

/**
 * The views an outfit changes (M7.1 PR-C).
 *
 * Only the full-figure ones. Head crops and expressions show a face, and
 * generating three expressions per outfit would double the most expensive
 * per-character stage in the chain to say nothing new about the face — the
 * same "an unused view is pure wall-clock" reasoning that kept action poses
 * out of the pack in PR-B.
 */
const WARDROBE_DEPENDENT_VIEWS: readonly CrpView[] = ["body_front", "body_side"];

export function isWardrobeDependent(view: CrpView): boolean {
  return WARDROBE_DEPENDENT_VIEWS.includes(view);
}

/**
 * Which pack views can stand in for a character in a panel, best first.
 *
 * A close-up conditioned on a full-figure plate has a head a few dozen pixels
 * tall to learn a face from; a wide conditioned on a head crop has nothing to
 * say about build or posture. Matching the reference's framing to the shot's is
 * the whole reason a pack is worth generating rather than one portrait.
 *
 * Every list ends at `head_front`, the anchor, which always exists for a locked
 * character — so this degrades to exactly the pre-pack behaviour rather than to
 * no reference at all.
 */
export function crpViewPreference(shotType: StoryboardShotType): readonly CrpView[] {
  switch (shotType) {
    case "extreme-close-up":
    case "close-up":
      return ["head_three_quarter", "head_front", "head_side"];
    case "medium":
      return ["body_front", "head_three_quarter", "head_front"];
    case "wide":
      return ["body_front", "body_side", "head_front"];
  }
}

type WardrobeCandidate = { name?: unknown; description?: unknown };

/**
 * Lock how this character sounds (M7.2) — the audible half of the identity
 * lock casting was always defined to include.
 *
 * `characters.voiceDesignNotes` has existed since M7 PR12 and nothing ever
 * wrote to it, which was invisible while the movie engine produced no audio.
 * LTX generates speech from the words in its own prompt, in the documented
 * form `[Speaker] says, in a [delivery], "[line]"` — so without a locked
 * delivery phrase the same character is voiced differently in every shot.
 * That is the audible version of the drift ADR 0001's reference portraits
 * exist to prevent, and it is fixed the same way: decide once, at casting,
 * and treat it as fixed input afterwards.
 *
 * Written once, never refreshed, for exactly the reason `proposeWardrobe`
 * above is not: re-proposing would let a later run revoice a cast whose
 * identity is explicitly locked. A model that returns nothing usable leaves
 * the column null and the character simply has no delivery clause, which is
 * how every project that predates this behaves.
 */
async function proposeVoiceDesign(
  ctx: StageContext,
  character: { name: string; arc: string | null },
  visualDescription: string,
): Promise<string> {
  const provider = resolveDevProvider(ctx.db);
  try {
    const payload = await ctx.llmClient(provider).chatJson<{ voice?: unknown }>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "casting.voice", {
            characterDescription: visualDescription,
            characterArc: character.arc ? `Arc: ${character.arc}` : "",
          }),
        },
      ],
      temperature: 0.3,
    });
    const voice = typeof payload.voice === "string" ? payload.voice.trim() : "";
    // A model that ignores the twelve-word instruction and returns a paragraph
    // would put a paragraph into every one of this character's prompts.
    return voice.split(/\s+/).length > 20 ? "" : voice;
  } catch (error) {
    ctx.log(
      `Voice design failed for ${character.name} (${(error as Error).message}) — ` +
        `their lines will be spoken without a delivery direction`,
      "warn",
    );
    return "";
  }
}

/**
 * Propose this character's approved outfits, once (M7.1 PR-C).
 *
 * Called only when a character has no variants at all — never to refresh them.
 * Re-proposing on a later run would let a second call invent a different
 * wardrobe for a cast whose identity is explicitly locked, leaving already
 * generated body views depicting outfits no row describes any more.
 *
 * A model that returns nothing usable is not an error: the character falls back
 * to a single variant built from their own description, which is exactly the
 * behaviour before this PR existed. Failing the stage here would make casting —
 * already the second most expensive stage in the chain — fail on a bad JSON
 * response after the portrait work was already paid for.
 */
async function proposeWardrobe(
  ctx: StageContext,
  character: { id: string; name: string; arc: string | null },
  visualDescription: string,
) {
  const provider = resolveDevProvider(ctx.db);
  let candidates: WardrobeCandidate[] = [];
  try {
    const payload = await ctx
      .llmClient(provider)
      .chatJson<{ variants?: WardrobeCandidate[] }>({
        model: provider.model,
        messages: [
          {
            role: "user",
            content: renderPrompt(ctx.db, "casting.wardrobe", {
              characterDescription: visualDescription,
              characterArc: character.arc ? `Arc: ${character.arc}` : "",
            }),
          },
        ],
        temperature: 0.3,
      });
    candidates = payload.variants ?? [];
  } catch (error) {
    ctx.log(
      `Wardrobe proposal failed for ${character.name} (${(error as Error).message}) — ` +
        `using one default outfit from their description`,
      "warn",
    );
  }

  const usable = candidates
    .filter(
      (v): v is { name: string; description: string } =>
        typeof v?.name === "string" &&
        v.name.trim().length > 0 &&
        typeof v?.description === "string" &&
        v.description.trim().length > 0,
    )
    // Two is the cap: each variant adds two full-figure generations to the most
    // expensive per-character stage there is (~130s each, finding F30), and two
    // is what the M7.1 plan itself recommends for v1.
    .slice(0, 2);

  const rows = usable.length > 0 ? usable : [{ name: "Default", description: visualDescription }];
  return rows.map(
    (row, index) =>
      ctx.db
        .insert(wardrobeVariants)
        .values({
          characterId: character.id,
          name: row.name.trim(),
          description: row.description.trim(),
          isDefault: index === 0,
        })
        .returning()
        .all()[0]!,
  );
}

export async function runCasting(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project, imageStyle } = bundle;
  const imageProvider = resolveProvider(ctx.db, "image");
  const backend = ctx.imageBackend();

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  if (cast.length === 0) {
    throw new Error(`Project ${projectId} has no characters to cast`);
  }

  const jobCharacterId =
    typeof ctx.job.payload.characterId === "string" ? ctx.job.payload.characterId : undefined;

  const pending = jobCharacterId
    ? cast.filter((character) => character.id === jobCharacterId && !character.imageAssetId)
    : cast.filter((character) => !character.imageAssetId);

  // BUG-29. A re-roll's direction is CONTENT — "older, grey at the temples"
  // says what the person physically looks like, the same register as their
  // own description — so it is appended to the rendered template and stays
  // *inside* Image Style's promptPrefix/promptSuffix, which are the rendering
  // register and belong to the style rather than to one job (ADR 0002). Same
  // placement `runConceptArt` above and `runCharacterImages` (images.ts) use.
  // It reaches the derived views too, not just the anchor: a scoped casting
  // redo deletes the whole reference pack (`regenerate`, lib/projects.ts), so
  // a direction applied only to the portrait would leave eight views
  // describing the person the redo was asked to stop drawing. No scope test
  // around it the way images.ts needs one — `pending` above and `packFor`
  // below are already narrowed to the named character when the job carries
  // one, so an unscoped whole-stage redo carrying direction applies it to the
  // whole cast, exactly as that stage does.
  const direction = pendingDirection(ctx);
  const directionPhrase = direction ? `, ${direction}` : "";

  for (const [position, character] of pending.entries()) {
    checkAbort(ctx);

    // `runCharacterImages` refuses to fall back to `description` here — for
    // the narrative pipeline, `description` is narrative prose extracted
    // alongside a separate, purely-visual `appearanceTag`, so a fallback
    // would silently draw a portrait from a character's backstory. Neither
    // half of that reasoning holds for the dev chain: its own "characters+
    // arcs" stage (`runDevCharacters`) never populates `appearanceTag` at
    // all (that column is a narrative-pipeline-only extraction — see its own
    // comment, schema.ts), and `description` is the only descriptive field
    // this stage has to work with — the "one paragraph of who they are"
    // equivalent, not backstory. `description` is NOT NULL at the schema
    // level, so this always has something to render.
    const visualDescription = character.appearanceTag ?? character.description;

    const prompt =
      `${imageStyle.promptPrefix}` +
      renderPrompt(ctx.db, "character.portrait", {
        characterDescription: visualDescription,
      }) +
      directionPhrase +
      `${imageStyle.promptSuffix}`;

    ctx.log(`Generating portrait for ${character.name} (${position + 1}/${pending.length})`);
    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: ctx.config.referenceImage.width,
        height: ctx.config.referenceImage.height,
        references: [],
      },
      {
        onProgress: (fraction) => ctx.progress((position + fraction) / Math.max(pending.length, 1)),
        shouldAbort: ctx.shouldAbort,
        log: ctx.log,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `character-${character.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      meta: { characterId: character.id, prompt },
    });
    const refInputName = await backend.uploadReference(bytes, `${character.id}.png`);

    // Voice is locked in the same write as the face (M7.2). Casting was
    // always defined as locking visual reference *and* voice design; only the
    // visual half was ever implemented. Doing both here means a character
    // cannot end up locked-looking and unlocked-sounding.
    const voiceDesignNotes = character.voiceDesignNotes ?? (await proposeVoiceDesign(ctx, character, visualDescription));

    // Generation and lock happen together, deliberately — see this
    // function's own doc comment on why casting has no separate approval
    // step.
    ctx.db
      .update(characters)
      .set({
        imagePrompt: prompt,
        imageAssetId: asset.id,
        refInputName,
        voiceDesignNotes: voiceDesignNotes || null,
        castingLockedAt: new Date(),
      })
      .where(eq(characters.id, character.id))
      .run();
  }

  // ---------------------------------------------------------------- the pack
  //
  // Every derived view is generated *from* the anchor portrait, passed as the
  // sole reference, which is what makes a pack internally consistent rather
  // than eight independent guesses at the same person. Resumable per view (a
  // row with an image is skipped) for the same reason every other image stage
  // here is: a pack is roughly a quarter-hour per character on this box
  // (findings F12/F30), so a crash partway through must cost one view, not the
  // whole pack.
  //
  // Runs over the whole in-scope cast rather than only `pending`: a character
  // whose anchor already existed before this PR has no pack at all, and would
  // otherwise never get one without a redo.
  const packFor = jobCharacterId ? cast.filter((c) => c.id === jobCharacterId) : cast;
  const havePackRows = ctx.db
    .select()
    .from(characterReferenceImages)
    .where(
      inArray(
        characterReferenceImages.characterId,
        packFor.map((c) => c.id),
      ),
    )
    .all();
  const packByKey = new Map(
    havePackRows.map((row) => [
      `${row.characterId}::${packKey(row.view, row.wardrobeVariantId)}`,
      row,
    ]),
  );

  for (const character of packFor) {
    // Re-read: the loop above may have just written this character's anchor.
    const anchor = ctx.db.select().from(characters).where(eq(characters.id, character.id)).get();
    if (!anchor?.imageAssetId) continue;

    // The anchor is recorded as a pack row too, so "the pack" is one queryable
    // set rather than "`characters` plus a table of everything else". It owns
    // no separate generation — this points at the portrait already made above.
    const anchorRow = packByKey.get(`${character.id}::${packKey("head_front", null)}`);
    if (!anchorRow) {
      ctx.db
        .insert(characterReferenceImages)
        .values({
          characterId: character.id,
          view: "head_front",
          prompt: anchor.imagePrompt ?? "",
          imageAssetId: anchor.imageAssetId,
          refInputName: anchor.refInputName,
        })
        .run();
    }

    const anchorRef = anchor.refInputName;
    const visualDescription = anchor.appearanceTag ?? anchor.description;

    // M7.1 PR-C — the outfits this character's body views are generated in.
    // Proposed once and then left alone: re-proposing on every run would let a
    // second call invent a different wardrobe for a cast whose identity is
    // explicitly locked, and the pack rows already generated would be of
    // outfits no variant row describes any more.
    let variants = ctx.db
      .select()
      .from(wardrobeVariants)
      .where(eq(wardrobeVariants.characterId, character.id))
      .all();
    if (variants.length === 0) {
      variants = await proposeWardrobe(ctx, anchor, visualDescription);
    }
    const defaultVariant = variants.find((v) => v.isDefault) ?? variants[0]!;

    // One job per (view, outfit) — but only body views multiply, so a
    // two-outfit character costs two extra generations, not eight.
    const jobs = CRP_DERIVED_VIEWS.flatMap((view) =>
      isWardrobeDependent(view)
        ? variants.map((variant) => ({ view, variant }))
        : [{ view, variant: null as (typeof variants)[number] | null }],
    ).filter(
      ({ view, variant }) =>
        !packByKey.get(`${character.id}::${packKey(view, variant?.id ?? null)}`)?.imageAssetId,
    );

    for (const [index, { view, variant }] of jobs.entries()) {
      checkAbort(ctx);
      const spec = CRP_VIEW_SPECS[view];
      const size = spec.body ? ctx.config.referenceBodyImage : ctx.config.referenceImage;

      // The outfit is folded into the subject description rather than given
      // its own template variable: it is part of what the person looks like,
      // and an empty variable would leave a dangling comma in a
      // comma-separated diffusion prompt for every wardrobe-independent view.
      const described = variant ? `${visualDescription}, wearing ${variant.description}` : visualDescription;

      const prompt =
        `${imageStyle.promptPrefix}` +
        renderPrompt(ctx.db, "character.reference_view", {
          viewFraming: spec.framing,
          characterDescription: described,
          viewDetail: spec.detail,
        }) +
        directionPhrase +
        `${imageStyle.promptSuffix}`;

      ctx.log(
        `Generating ${view.replace(/_/g, " ")}${variant ? ` (${variant.name})` : ""} for ` +
          `${anchor.name} (${index + 1}/${jobs.length})`,
      );
      const bytes = await backend.generate(
        {
          prompt,
          negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
          width: size.width,
          height: size.height,
          // A dangling anchor degrades this view to a text-only generation
          // rather than failing the pack, the same rule ADR 0001 sets for
          // scene images and `filterLiveRefs` applies everywhere else.
          references: anchorRef && (await backend.hasReference(anchorRef)) ? [anchorRef] : [],
        },
        { shouldAbort: ctx.shouldAbort, log: ctx.log },
      );

      const slug = variant ? `${view}-${variant.id}` : view;
      const asset = storeAsset(ctx.db, ctx.config, {
        kind: "image",
        bytes,
        mimeType: "image/png",
        projectId,
        label: `character-${anchor.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slug}`,
        meta: { characterId: character.id, view, wardrobeVariantId: variant?.id ?? null, prompt },
      });
      const refInputName = await backend.uploadReference(bytes, `${character.id}-${slug}.png`);

      const existing = packByKey.get(`${character.id}::${packKey(view, variant?.id ?? null)}`);
      if (existing) {
        ctx.db
          .update(characterReferenceImages)
          .set({ prompt, imageAssetId: asset.id, refInputName })
          .where(eq(characterReferenceImages.id, existing.id))
          .run();
      } else {
        ctx.db
          .insert(characterReferenceImages)
          .values({
            characterId: character.id,
            view,
            wardrobeVariantId: variant?.id ?? null,
            prompt,
            imageAssetId: asset.id,
            refInputName,
          })
          .run();
      }
    }
  }

  // A whole-cast run also locks any character that already had a portrait
  // coming in (e.g. one a redo left untouched) but wasn't locked yet — a
  // per-character scoped run leaves the rest of the cast alone, same as
  // `runCharacterImages`' own `jobCharacterId` scoping.
  if (!jobCharacterId) {
    ctx.db
      .update(characters)
      .set({ castingLockedAt: new Date() })
      .where(and(eq(characters.projectId, projectId), isNull(characters.castingLockedAt)))
      .run();
  }

  ctx.log(
    pending.length === 0
      ? "No portraits needed"
      : `${pending.length} portrait(s) generated, uploaded as references, and locked`,
  );

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  if (jobCharacterId) return;
  ctx.log("Casting locked");
}

/** A count of storyboard panels or shot list items, grouped by `sceneId`, sorted by scene. */
function countsBySceneId(rows: { sceneId: string }[]): string {
  if (rows.length === 0) return "(none)";
  const bySceneId = new Map<string, number>();
  for (const row of rows) {
    bySceneId.set(row.sceneId, (bySceneId.get(row.sceneId) ?? 0) + 1);
  }
  return [...bySceneId.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([sceneId, count]) => `- Scene ${sceneId}: ${count}`)
    .join("\n");
}

/**
 * Stage 21, Preproduction's own capstone (M7 PR13) — exactly the same shape
 * as `runStoryBible` closing out Development: assembles one document from
 * every already-approved Preproduction artifact (script/scene breakdown,
 * continuity, visual bible, production design, the locked cast, locations/
 * props, storyboard/shot-list counts, and the previs animatic if one
 * exists), formatting rather than writing new prose. No provider is
 * resolved and no `sd-api` call is made.
 *
 * Only reports what actually exists for this project — a project that never
 * ran "previs" gets no "previs exists" claim, the same restraint
 * `runVisualBible`'s locations/props sections already show when a project
 * has none. Left unapproved on write, like every other capstone here — the
 * ordinary "approve and continue" mechanism (chain.ts's `advance`) is what
 * gates `devNextStep`'s terminal "Preproduction approved, ready for
 * Production" state on a human's sign-off.
 */
export async function runProductionPlan(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;

  const storyBible = requireDevArtifactContent(ctx.db, projectId, "story_bible");
  const scriptBreakdown = requireDevArtifactContent(ctx.db, projectId, "script_breakdown");
  const sceneBreakdown = requireDevArtifactContent(ctx.db, projectId, "scene_breakdown");
  const visualBible = requireDevArtifactContent(ctx.db, projectId, "visual_bible");
  const productionDesign = requireDevArtifactContent(ctx.db, projectId, "production_design");

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const locs = ctx.db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = ctx.db.select().from(props).where(eq(props.projectId, projectId)).all();
  const panels = ctx.db.select().from(storyboardPanels).where(eq(storyboardPanels.projectId, projectId)).all();
  const shots = ctx.db.select().from(shotListItems).where(eq(shotListItems.projectId, projectId)).all();

  const castSection =
    cast.length > 0
      ? cast
          .map((c) => {
            const lockStatus = c.castingLockedAt ? "locked" : "not locked";
            const voiceNotes = c.voiceDesignNotes ? ` — Voice: ${c.voiceDesignNotes}` : "";
            return `- ${c.name} (${lockStatus})${voiceNotes}`;
          })
          .join("\n")
      : "(no cast)";

  const locationsSection =
    locs.length > 0
      ? locs
          .map((l) => `- ${l.name}: ${l.description}${l.imageAssetId ? " (concept art on file)" : ""}`)
          .join("\n")
      : "(none)";
  const propsSection =
    items.length > 0
      ? items.map((p) => `- ${p.name}: ${p.description}${p.imageAssetId ? " (concept art on file)" : ""}`).join("\n")
      : "(none)";

  const shotCountSection = [
    `Storyboard panels: ${panels.length} total`,
    panels.length > 0 ? countsBySceneId(panels) : undefined,
    `Shot list items: ${shots.length} total`,
    shots.length > 0 ? countsBySceneId(shots) : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");

  // Only reported when a previs render genuinely exists — `previsAssetId` is
  // the one signal that stage ran at all (see its own comment, schema.ts).
  const previsSection = project.previsAssetId
    ? `A previs animatic exists for this project (asset ${project.previsAssetId}).`
    : "No previs animatic was generated for this project.";

  const content = [
    `# What's Locked\n\n${storyBible}`,
    `# Script Breakdown\n\n${scriptBreakdown}`,
    `# Scene Breakdown\n\n${sceneBreakdown}`,
    `# Visual Bible\n\n${visualBible}`,
    `# Production Design\n\n${productionDesign}`,
    `# Cast\n\n${castSection}`,
    `# Locations\n\n${locationsSection}`,
    `# Props\n\n${propsSection}`,
    `# Shot Count Summary\n\n${shotCountSection}`,
    `# Previs\n\n${previsSection}`,
  ].join("\n\n");

  ctx.progress(0.5);
  writeDevArtifact(ctx.db, projectId, "production_plan", content, "", false);
  ctx.log("Production plan assembled");
  ctx.progress(1);
}
