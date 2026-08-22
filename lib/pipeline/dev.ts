import { and, desc, eq } from "drizzle-orm";
import { Fountain, type Script } from "fountain-js";
import {
  characters,
  devArtifacts,
  evaluations,
  locations,
  projects,
  props,
  worldBuilding,
  type DevArtifactStage,
} from "../db/schema";
import { renderPrompt } from "../prompts";
import { enqueue } from "../queue";
import type { Db } from "../db/client";
import {
  awaitReview,
  checkAbort,
  groundingInstruction,
  loadProject,
  requireDirectionStyle,
  requireProjectId,
  resolveDevProvider,
  type StageContext,
} from "./context";
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
function continueDevChain(ctx: StageContext, projectId: string, mode: "auto" | "manual", next: DevArtifactStage | "characters" | "world_building"): void {
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
