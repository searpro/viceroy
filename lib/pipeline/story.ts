import { desc, eq } from "drizzle-orm";
import { evaluations, projects } from "../db/schema";
import { renderPrompt } from "../prompts";
import { enqueue } from "../queue";
import {
  awaitReview,
  checkAbort,
  formatChecklist,
  loadProject,
  requireProjectId,
  resolveProvider,
  setStage,
  type StageContext,
} from "./context";

/** Stage 1 — the user's one-line idea becomes a working synopsis. */
export async function runSynopsis(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, narrativeStyle } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "llm");

  const direction = typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction : "";
  const key = project.synopsis && direction ? "synopsis.refine" : "synopsis.generate";

  const prompt = renderPrompt(ctx.db, key, {
    idea: project.idea,
    synopsis: project.synopsis ?? "",
    direction,
    narrativeStyle: narrativeStyle.name,
    plannerGuidance: narrativeStyle.plannerGuidance,
    targetSceneCount: String(narrativeStyle.targetSceneCount),
  });

  ctx.log(`Generating synopsis with ${provider.model} (${key})`);
  ctx.progress(0.1);
  checkAbort(ctx);

  const { content } = await ctx.sdApi.llm.chat({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.85,
  });

  ctx.db.update(projects).set({ synopsis: content }).where(eq(projects.id, projectId)).run();
  setStage(ctx.db, projectId, "synopsis");
  ctx.log(`Synopsis written (${wordCount(content)} words)`);

  advance(ctx, projectId, project.mode, "story");
}

/** Stage 2 — the synopsis becomes the full narration. */
export async function runStory(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, narrativeStyle, voiceStyle } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "llm");

  if (!project.synopsis) throw new Error(`Project ${projectId} has no synopsis to elaborate`);

  const prompt = renderPrompt(ctx.db, "story.write", {
    synopsis: project.synopsis,
    narrativeStyle: narrativeStyle.name,
    writingGuidance: narrativeStyle.writingGuidance,
    deliveryCues: voiceStyle.deliveryCues,
    targetSceneCount: String(narrativeStyle.targetSceneCount),
    targetWordCount: String(narrativeStyle.targetWordCount),
  });

  ctx.log(`Writing story with ${provider.model}`);
  ctx.progress(0.1);
  checkAbort(ctx);

  const { content } = await ctx.sdApi.llm.chat({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.9,
    maxTokens: narrativeStyle.targetWordCount * 4,
  });

  ctx.db.update(projects).set({ story: content }).where(eq(projects.id, projectId)).run();
  setStage(ctx.db, projectId, "story");
  ctx.log(`Story written (${wordCount(content)} words)`);

  // Evaluation runs in auto and manual alike: a manual reviewer is better off
  // seeing the evaluator's read alongside the draft than being asked cold.
  enqueue(ctx.db, { type: "story_eval", projectId });
}

type EvaluationPayload = {
  verdict?: unknown;
  dimensions?: Record<string, { score?: unknown; comment?: unknown }>;
  issues?: { severity?: unknown; note?: unknown; sceneIndex?: unknown }[];
};

/**
 * Stage 3 — score the story against its own style's checklist.
 *
 * Loops with `story_revise` until the story passes or the QC iteration
 * threshold is reached, at which point the project stops for a human rather
 * than burning attempts on a model that is not converging.
 */
export async function runStoryEval(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, narrativeStyle } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "llm");

  if (!project.story) throw new Error(`Project ${projectId} has no story to evaluate`);

  const prompt = renderPrompt(ctx.db, "story.evaluate", {
    story: project.story,
    narrativeStyle: narrativeStyle.name,
    checklist: formatChecklist(narrativeStyle),
  });

  ctx.log(`Evaluating story with ${provider.model}`);
  ctx.progress(0.1);
  checkAbort(ctx);

  const raw = await ctx.sdApi.llm.chatJson<EvaluationPayload>({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  const iteration = countEvaluations(ctx, projectId);
  const parsed = parseEvaluation(raw, narrativeStyle.evaluationChecklist.map((c) => c.key));

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

  setStage(ctx.db, projectId, "story_eval");
  ctx.log(
    `Evaluation ${iteration}: ${parsed.verdict}` +
      (parsed.overallScore ? ` (mean ${parsed.overallScore.toFixed(2)}/5)` : "") +
      (parsed.issues.length > 0 ? `, ${parsed.issues.length} issue(s)` : ""),
  );

  if (parsed.verdict === "pass") {
    ctx.log("Story passed evaluation");
    if (project.mode === "manual") {
      awaitReview(ctx.db, projectId);
      return;
    }
    enqueue(ctx.db, { type: "elements", projectId });
    return;
  }

  if (iteration >= ctx.config.qcMaxIterations) {
    const reason =
      `Story still failing evaluation after ${iteration} attempt(s) — ` +
      `QC threshold reached, stopping for review`;
    awaitReview(ctx.db, projectId, reason);
    ctx.log(reason, "warn");
    return;
  }

  enqueue(ctx.db, { type: "story_revise", projectId });
}

/** Stage 3b — rewrite the story against the evaluator's issues, then re-judge. */
export async function runStoryRevise(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, narrativeStyle } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "llm");

  if (!project.story) throw new Error(`Project ${projectId} has no story to revise`);

  const latest = ctx.db
    .select()
    .from(evaluations)
    .where(eq(evaluations.projectId, projectId))
    .orderBy(desc(evaluations.iteration))
    .get();

  if (!latest || latest.issues.length === 0) {
    throw new Error(`Project ${projectId} has no evaluation issues to revise against`);
  }

  const prompt = renderPrompt(ctx.db, "story.revise", {
    story: project.story,
    narrativeStyle: narrativeStyle.name,
    writingGuidance: narrativeStyle.writingGuidance,
    issues: latest.issues.map((i) => `- [${i.severity}] ${i.note}`).join("\n"),
    targetWordCount: String(narrativeStyle.targetWordCount),
  });

  ctx.log(`Revising story against ${latest.issues.length} issue(s)`);
  ctx.progress(0.1);
  checkAbort(ctx);

  const { content } = await ctx.sdApi.llm.chat({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
    maxTokens: narrativeStyle.targetWordCount * 4,
  });

  ctx.db.update(projects).set({ story: content }).where(eq(projects.id, projectId)).run();
  ctx.log(`Story revised (${wordCount(content)} words)`);

  enqueue(ctx.db, { type: "story_eval", projectId });
}

/* ----------------------------------------------------------------- helpers */

function advance(
  ctx: StageContext,
  projectId: string,
  mode: "auto" | "manual",
  next: "story",
): void {
  if (mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  enqueue(ctx.db, { type: next, projectId });
}

function countEvaluations(ctx: StageContext, projectId: string): number {
  return (
    ctx.db.select({ id: evaluations.id }).from(evaluations).where(eq(evaluations.projectId, projectId)).all()
      .length + 1
  );
}

/**
 * Coerce the model's JSON into the shape the schema expects.
 *
 * A 12B local model gets the structure right far more often than it gets the
 * vocabulary right, so unknown dimension keys are dropped rather than failing
 * the stage — but a response naming *no* known key means it judged something
 * other than what it was asked to, and that is worth failing on.
 */
export function parseEvaluation(
  raw: EvaluationPayload,
  allowedKeys: string[],
): {
  verdict: "pass" | "revise";
  overallScore: number | null;
  dimensions: Record<string, { score: number; comment: string }>;
  issues: { severity: "low" | "medium" | "high"; note: string; sceneIndex?: number }[];
} {
  const allowed = new Set(allowedKeys);
  const dimensions: Record<string, { score: number; comment: string }> = {};

  for (const [key, value] of Object.entries(raw.dimensions ?? {})) {
    if (!allowed.has(key)) continue;
    const score = Number(value?.score);
    if (!Number.isFinite(score)) continue;
    dimensions[key] = {
      score: Math.max(1, Math.min(5, score)),
      comment: typeof value?.comment === "string" ? value.comment : "",
    };
  }

  if (Object.keys(dimensions).length === 0) {
    throw new Error(
      `Evaluation named none of this style's checklist keys (${allowedKeys.join(", ")}) — ` +
        `it judged something other than what it was asked to`,
    );
  }

  const scores = Object.values(dimensions).map((d) => d.score);
  const overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  const issues = (raw.issues ?? [])
    .filter((i) => typeof i?.note === "string" && i.note.trim().length > 0)
    .map((i) => ({
      severity: (["low", "medium", "high"] as const).includes(i.severity as "low")
        ? (i.severity as "low" | "medium" | "high")
        : ("medium" as const),
      note: (i.note as string).trim(),
      ...(Number.isFinite(Number(i.sceneIndex)) ? { sceneIndex: Number(i.sceneIndex) } : {}),
    }));

  // Trust the scores over the stated verdict: models routinely say "pass"
  // while scoring a dimension at 2, and the checklist is the contract.
  const failingDimension = scores.some((s) => s <= 2);
  const statedRevise = raw.verdict === "revise";
  const verdict = failingDimension || statedRevise ? "revise" : "pass";

  return { verdict, overallScore, dimensions, issues: verdict === "pass" ? [] : issues };
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
