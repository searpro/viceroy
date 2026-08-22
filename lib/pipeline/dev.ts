import { and, desc, eq } from "drizzle-orm";
import {
  characters,
  devArtifacts,
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

/**
 * The Development chain's five PR2 stages — concept through story structure.
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
 * Stage 5 (of PR2's five) — the approved concept, logline, cast and world
 * become a numbered beat structure.
 *
 * Behaves exactly like the four stages above: auto mode approves its own
 * draft and hands off to whatever `DEV_CHAIN_STAGES` names next. That next
 * stage, "beat_sheet", has no `STAGE_HANDLERS` entry yet (PR3+ scope), so the
 * enqueued job simply fails the way any unimplemented job type already does
 * (worker/index.ts) — the same graceful "park the project for review" outcome
 * a special case here would produce, without a special case.
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
