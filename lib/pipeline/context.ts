import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db/client";
import {
  captionStyles,
  imageStyles,
  narrativeStyles,
  projects,
  providers,
  voiceStyles,
  type ProjectStage,
} from "../db/schema";
import type { ProviderKind } from "../providers";
import type { Job } from "../queue";
import type { SdApi } from "../sdapi";
import type { ImageBackend, VideoBackend } from "../backends/types";

export type StageContext = {
  db: Db;
  /**
   * The sd-api client for the kinds sd-api is the only backend for: llm,
   * audio and asr. Image and video go through the backends below instead,
   * because they are the two kinds a host other than sd-api can serve.
   */
  sdApi: SdApi;
  /**
   * Resolved on call rather than up front: an LLM stage must not fail because
   * no image provider is configured, and a worker resolving both at job start
   * would do exactly that.
   */
  imageBackend: () => ImageBackend;
  videoBackend: () => VideoBackend;
  config: Config;
  job: Job;
  log: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
  progress: (fraction: number) => void;
  shouldAbort: () => boolean;
};

export type StageHandler = (ctx: StageContext) => Promise<void>;

export class AbortedError extends Error {
  constructor() {
    super("Aborted at the operator's request");
    this.name = "AbortedError";
  }
}

/** Bail out at a checkpoint if an abort was requested while we were working. */
export function checkAbort(ctx: StageContext): void {
  if (ctx.shouldAbort()) throw new AbortedError();
}

export type ProjectBundle = {
  project: typeof projects.$inferSelect;
  narrativeStyle: typeof narrativeStyles.$inferSelect;
  voiceStyle: typeof voiceStyles.$inferSelect;
  imageStyle: typeof imageStyles.$inferSelect;
  // Unlike the other three, optional and not part of the required check
  // below: it only matters to the final render stage, and a project created
  // before captionStyleId existed has no way to have one set. render.ts
  // falls back to DEFAULT_CAPTION_STYLE when this is undefined.
  captionStyle: typeof captionStyles.$inferSelect | undefined;
};

/**
 * Load a project with its style set.
 *
 * Every generation stage needs the narrative/voice/image triple, and every
 * one needs to fail the same way when one is missing — a project without a
 * narrative style has no checklist to be judged against and no guidance to be
 * written from.
 */
export function loadProject(db: Db, projectId: string): ProjectBundle {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No such project: ${projectId}`);

  const narrativeStyle = project.narrativeStyleId
    ? db.select().from(narrativeStyles).where(eq(narrativeStyles.id, project.narrativeStyleId)).get()
    : undefined;
  const voiceStyle = project.voiceStyleId
    ? db.select().from(voiceStyles).where(eq(voiceStyles.id, project.voiceStyleId)).get()
    : undefined;
  const imageStyle = project.imageStyleId
    ? db.select().from(imageStyles).where(eq(imageStyles.id, project.imageStyleId)).get()
    : undefined;
  const captionStyle = project.captionStyleId
    ? db.select().from(captionStyles).where(eq(captionStyles.id, project.captionStyleId)).get()
    : undefined;

  const missing = [
    !narrativeStyle && "narrative style",
    !voiceStyle && "voice style",
    !imageStyle && "image style",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Project ${projectId} has no ${missing.join(", no ")}`);
  }

  return {
    project,
    narrativeStyle: narrativeStyle!,
    voiceStyle: voiceStyle!,
    imageStyle: imageStyle!,
    captionStyle,
  };
}

export function requireProjectId(job: Job): string {
  if (!job.projectId) throw new Error(`Job ${job.id} (${job.type}) has no project`);
  return job.projectId;
}

export function resolveProvider(db: Db, kind: ProviderKind) {
  const provider =
    db
      .select()
      .from(providers)
      .where(and(eq(providers.kind, kind), eq(providers.isDefault, true)))
      .get() ?? db.select().from(providers).where(eq(providers.kind, kind)).get();

  if (!provider) throw new Error(`No ${kind} provider configured`);
  return provider;
}

export function setStage(db: Db, projectId: string, stage: ProjectStage): void {
  db.update(projects).set({ stage }).where(eq(projects.id, projectId)).run();
}

/** Park a project for the user: manual mode, or auto mode hitting a threshold. */
export function awaitReview(db: Db, projectId: string, reason?: string): void {
  db.update(projects)
    .set({ awaitingReview: true, ...(reason ? { failureReason: reason } : {}) })
    .where(eq(projects.id, projectId))
    .run();
}

/**
 * `extra` lets a caller append checklist items that do not belong to the
 * style itself — e.g. `factual_grounding`, which only applies to Context-mode
 * projects and would otherwise mean touching every `narrative_styles` row.
 */
export function formatChecklist(
  style: typeof narrativeStyles.$inferSelect,
  extra: { key: string; description: string }[] = [],
): string {
  return [...style.evaluationChecklist, ...extra].map((c) => `- ${c.key}: ${c.description}`).join("\n");
}

// Appended to `factual_grounding` when Context mode is active — kept next to
// the checklist builder so the wording used to score a project always matches
// the wording used to prompt it.
export const FACTUAL_GROUNDING_CHECKLIST_ITEM = {
  key: "factual_grounding",
  description:
    "Introduces no people, events, dates, causes or outcomes beyond what the supplied " +
    "context states or reasonably paraphrases.",
};

/**
 * The clause every story-content stage injects when a project is grounded in
 * user-supplied source material rather than a freely invented idea.
 *
 * Empty in Idea mode, so every template that references `{{groundingInstruction}}`
 * degrades to today's behaviour with no visible change in the rendered prompt.
 */
export function groundingInstruction(project: typeof projects.$inferSelect): string {
  if (project.inputMode !== "context") return "";
  return (
    "This project is grounded in source material the user supplied, not a freely " +
    "invented premise. Treat that material as the factual ground truth: do not introduce " +
    "characters, events, dates, causes or outcomes that are not present in it or a " +
    "reasonable paraphrase of it. If the material runs out before the requested length, " +
    "stay narrower and more incomplete rather than inventing to fill the gap. This is a " +
    "prompt-adherence instruction, not fact-checking against the real world — you have no " +
    "way to verify the material itself, only to avoid adding to it."
  );
}
