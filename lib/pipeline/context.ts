import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db/client";
import {
  imageStyles,
  narrativeStyles,
  projects,
  providers,
  voiceStyles,
  type ProjectStage,
} from "../db/schema";
import type { Job } from "../queue";
import type { SdApi } from "../sdapi";

export type StageContext = {
  db: Db;
  sdApi: SdApi;
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
};

/**
 * Load a project with its three styles.
 *
 * Every stage needs the style triple, and every stage needs to fail the same
 * way when one is missing — a project without a narrative style has no
 * checklist to be judged against and no guidance to be written from.
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
  };
}

export function requireProjectId(job: Job): string {
  if (!job.projectId) throw new Error(`Job ${job.id} (${job.type}) has no project`);
  return job.projectId;
}

export function resolveProvider(db: Db, kind: "llm" | "image" | "audio" | "asr") {
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

export function formatChecklist(style: typeof narrativeStyles.$inferSelect): string {
  return style.evaluationChecklist.map((c) => `- ${c.key}: ${c.description}`).join("\n");
}
