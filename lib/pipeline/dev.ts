import { and, asc, desc, eq } from "drizzle-orm";
import { Fountain, type Script } from "fountain-js";
import {
  characters,
  CONTINUITY_SUBJECT_TYPES,
  continuityFacts,
  devArtifacts,
  evaluations,
  locations,
  projects,
  props,
  shotListItems,
  storyboardPanels,
  STORYBOARD_CAMERA_ANGLES,
  STORYBOARD_CAMERA_MOVEMENTS,
  STORYBOARD_LENSES,
  STORYBOARD_SHOT_TYPES,
  worldBuilding,
  type ContinuitySubjectType,
  type DevArtifactStage,
} from "../db/schema";
import { storeAsset } from "../assets";
import { renderPrompt } from "../prompts";
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const payload = await ctx.sdApi.llm.chatJson<DevCharacterPayload>({
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

  const payload = await ctx.sdApi.llm.chatJson<WorldBuildingPayload>({
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const { content } = await ctx.sdApi.llm.chat({
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

    const raw = await ctx.sdApi.llm.chatJson<EvaluationPayload>({
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

    const { content: revised } = await ctx.sdApi.llm.chat({
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const { content } = await ctx.sdApi.llm.chat({
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

  const payload = await ctx.sdApi.llm.chatJson<ContinuityPayload>({
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

  const { content } = await ctx.sdApi.llm.chat({
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
 * Stage 16 (M7 PR9) — the first stage in this whole chain that generates
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

  const pendingLocations = locs.filter((l) => !l.imageAssetId);
  const pendingProps = items.filter((p) => !p.imageAssetId);
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
      `${imageStyle.promptSuffix}`;

    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
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
      `${imageStyle.promptSuffix}`;

    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
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
  ctx.db
    .update(projects)
    .set({ conceptArtApprovedAt: project.mode === "auto" ? new Date() : null })
    .where(eq(projects.id, projectId))
    .run();

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
 * Stage 17 (M7 PR10) — one storyboard panel per beat in the approved scene
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
 * RENDERING register) but is the first Preproduction stage to call
 * `filterLiveRefs` for real, against `locations`/`props`: a panel whose beat
 * text mentions a known location or prop by name gets that entity's
 * concept-art reference passed as `references`, the same way
 * `runSceneImages` (images.ts) references character portraits. The matching
 * heuristic is a simple case-insensitive substring check of the entity's
 * name against the beat's description — good enough for continuity between a
 * panel and the concept art it's meant to be consistent with, without a
 * second extraction pass just to name which entities a beat "is about".
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

  ctx.log(`Extracting storyboard beats with ${provider.model}`);
  ctx.progress(0.05);
  checkAbort(ctx);

  const payload = await ctx.sdApi.llm.chatJson<StoryboardBeatsPayload>({
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

  const locs = ctx.db.select().from(locations).where(eq(locations.projectId, projectId)).all();
  const items = ctx.db.select().from(props).where(eq(props.projectId, projectId)).all();
  const liveLocationRefs = await filterLiveRefs(backend, locs, ctx.log);
  const livePropRefs = await filterLiveRefs(backend, items, ctx.log);

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
    ctx.log(
      `Generating storyboard panel for scene ${beat.sceneId}, beat ${beat.index + 1} (${done + 1}/${pending.length})`,
    );

    // Simple name-mention matching against concept-art references — keeps a
    // panel visually consistent with the world a human already generated,
    // without a second extraction pass to identify which entities a beat "is
    // about". See this function's own doc comment.
    const mentioned = [...locs, ...items].filter((entity) =>
      beat.description.toLowerCase().includes(entity.name.toLowerCase()),
    );
    const refs = mentioned
      .map((entity) => liveLocationRefs.get(entity.id) ?? livePropRefs.get(entity.id))
      .filter((name): name is string => Boolean(name));

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
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
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
  ctx.log("Storyboards is the last Preproduction stage defined so far — nothing further to enqueue");
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
};

// A plausible default for one shot's screen time when the model's own
// estimate is missing or nonsensical — sits mid-range of the prompt's own
// "typically 2000-6000ms" guidance, not at either edge, so a bad estimate
// degrades to something a previs animatic can still cut on rather than to a
// value that reads as broken (a 0ms or 60000ms shot).
const DEFAULT_SHOT_DURATION_MS = 4000;
const MIN_SHOT_DURATION_MS = 1000;
const MAX_SHOT_DURATION_MS = 15_000;

/** Clamp a model-supplied duration estimate into a sane range, defaulting on anything unusable. */
function coerceDurationHintMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SHOT_DURATION_MS;
  return Math.round(Math.min(MAX_SHOT_DURATION_MS, Math.max(MIN_SHOT_DURATION_MS, value)));
}

/**
 * Stage 18 (M7 PR11) — one `shot_list_items` row per approved storyboard
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

    const payload = await ctx.sdApi.llm.chatJson<ShotListRefinement>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "dev.shot_list", {
            storyboardPanelPrompt: panel.panelImagePrompt,
            shotDescriptor,
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
        durationHintMs: coerceDurationHintMs(payload.durationHintMs),
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
