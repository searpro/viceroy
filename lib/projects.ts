import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { resolveConfig } from "./config";
import type { Db } from "./db/client";
import {
  captionStyles,
  characters,
  evaluations,
  imageStyles,
  narrativeStyles,
  preferences,
  projects,
  renders,
  scenes,
  subtitleCues,
  voiceovers,
  voiceStyles,
} from "./db/schema";
import { enqueue, listJobs } from "./queue";
import { advance, isStalled, nextStep } from "./pipeline/chain";
import { RESOLUTION_KEYS, resolvePresetDimensions } from "./resolution";

// A sane UX ceiling, not a measured model token-budget limit (Finding F10
// covers the actual, model-dependent context window) — see VIC-003.
const CONTEXT_MAX = 8000;

export const createProjectSchema = z
  .object({
    // Deliberately not named `mode` — `mode` already means the auto/manual
    // review cadence below. This chooses where the story's facts come from.
    inputMode: z.enum(["idea", "context"]).default("idea"),
    idea: z.string().trim().max(2000).optional(),
    context: z.string().trim().max(CONTEXT_MAX).optional(),
    narrativeStyleId: z.string().optional(),
    voiceStyleId: z.string().optional(),
    imageStyleId: z.string().optional(),
    captionStyleId: z.string().optional(),
    resolutionKey: z.enum(RESOLUTION_KEYS).optional(),
    mode: z.enum(["auto", "manual"]).default("auto"),
  })
  .superRefine((data, ctx) => {
    if (data.inputMode === "idea") {
      if (!data.idea || data.idea.length < 8) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["idea"],
          message: "Give the idea a little more to work with",
        });
      }
    } else if (!data.context || data.context.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context"],
        message: "Paste in more context to work with",
      });
    }
  });

// `z.input` rather than `z.infer`, so callers may omit anything with a default
// — the function parses what it is given rather than trusting it.
export type CreateProjectInput = z.input<typeof createProjectSchema>;

function preferenceValue(db: Db, key: string): string | undefined {
  const row = db.select().from(preferences).where(eq(preferences.key, key)).get();
  return typeof row?.value === "string" ? row.value : undefined;
}

/**
 * Resolve a style, falling back to the configured default and then to whatever
 * exists.
 *
 * The last fallback matters: a fresh install with seeded styles but no
 * preferences should still be able to start a project rather than erroring on
 * a lookup the user never knew they had to make.
 */
function resolveStyle<T extends { id: string; name: string }>(
  rows: T[],
  explicitId: string | undefined,
  defaultName: string | undefined,
  label: string,
): T {
  if (explicitId) {
    const found = rows.find((r) => r.id === explicitId);
    if (!found) throw new Error(`No such ${label}: ${explicitId}`);
    return found;
  }
  const byName = defaultName ? rows.find((r) => r.name === defaultName) : undefined;
  const chosen = byName ?? rows[0];
  if (!chosen) throw new Error(`No ${label} exists — has the seed run?`);
  return chosen;
}

/** A short caller-facing label for a Context-mode project's `idea`/`title`. */
function shortLabel(context: string): string {
  const firstLine = context.trim().split("\n")[0]!.trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

export function createProject(db: Db, raw: CreateProjectInput) {
  const input = createProjectSchema.parse(raw);
  const narrative = resolveStyle(
    db.select().from(narrativeStyles).all(),
    input.narrativeStyleId,
    preferenceValue(db, "defaultNarrativeStyle"),
    "narrative style",
  );
  const voice = resolveStyle(
    db.select().from(voiceStyles).all(),
    input.voiceStyleId,
    preferenceValue(db, "defaultVoiceStyle"),
    "voice style",
  );
  const image = resolveStyle(
    db.select().from(imageStyles).all(),
    input.imageStyleId,
    preferenceValue(db, "defaultImageStyle"),
    "image style",
  );
  const caption = resolveStyle(
    db.select().from(captionStyles).all(),
    input.captionStyleId,
    preferenceValue(db, "defaultCaptionStyle"),
    "caption style",
  );
  const resolution = resolvePresetDimensions(resolveConfig(), input.resolutionKey);

  // `idea` stays NOT NULL either way — rather than a nullability change, a
  // Context-mode project gets a short label derived from its context, which
  // doubles as `title` for the list/job views that already fall back to it.
  const isContext = input.inputMode === "context";
  const label = isContext ? shortLabel(input.context!) : input.idea!;

  const [project] = db
    .insert(projects)
    .values({
      idea: label,
      title: isContext ? label : null,
      inputMode: input.inputMode,
      context: isContext ? input.context : null,
      mode: input.mode,
      narrativeStyleId: narrative.id,
      voiceStyleId: voice.id,
      imageStyleId: image.id,
      captionStyleId: caption.id,
      width: resolution.width,
      height: resolution.height,
    })
    .returning()
    .all();

  enqueue(db, { type: "synopsis", projectId: project!.id });
  return project!;
}

export function listProjects(db: Db) {
  return db.select().from(projects).orderBy(desc(projects.createdAt)).limit(50).all();
}

/**
 * Every job across every project, newest first, each carrying enough of its
 * project to be identifiable without a second round trip per row.
 *
 * A plain join would return the same handful of project rows once per job;
 * fetching the distinct set separately and merging in JS is simpler than
 * writing that join and costs nothing extra since the project count is
 * always far smaller than the job count.
 */
export function listAllJobs(db: Db, opts: { limit?: number } = {}) {
  const jobRows = listJobs(db, { limit: opts.limit ?? 200 }).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );

  const projectIds = [...new Set(jobRows.map((j) => j.projectId).filter((id): id is string => !!id))];
  const projectRows =
    projectIds.length > 0
      ? db
          .select({ id: projects.id, idea: projects.idea, title: projects.title })
          .from(projects)
          .where(inArray(projects.id, projectIds))
          .all()
      : [];
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  return jobRows.map((job) => ({
    ...job,
    project: job.projectId ? (projectById.get(job.projectId) ?? null) : null,
  }));
}

export function getProjectDetail(db: Db, projectId: string) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return undefined;

  return {
    project,
    narrativeStyle: project.narrativeStyleId
      ? db.select().from(narrativeStyles).where(eq(narrativeStyles.id, project.narrativeStyleId)).get()
      : undefined,
    voiceStyle: project.voiceStyleId
      ? db.select().from(voiceStyles).where(eq(voiceStyles.id, project.voiceStyleId)).get()
      : undefined,
    evaluations: db
      .select()
      .from(evaluations)
      .where(eq(evaluations.projectId, projectId))
      .orderBy(desc(evaluations.iteration))
      .all(),
    scenes: db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.index))
      .all(),
    characters: db.select().from(characters).where(eq(characters.projectId, projectId)).all(),
    voiceover: db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get(),
    render: db
      .select()
      .from(renders)
      .where(eq(renders.projectId, projectId))
      .orderBy(desc(renders.createdAt))
      .get(),
    cues: db
      .select()
      .from(subtitleCues)
      .where(eq(subtitleCues.projectId, projectId))
      .orderBy(asc(subtitleCues.index))
      .all(),
    jobs: listJobs(db, { projectId }),
    nextStep: nextStep(db, projectId),
    stalled: isStalled(db, projectId),
  };
}

/** Approve what is there and queue whatever is outstanding. */
export function continueProject(db: Db, projectId: string) {
  return advance(db, projectId);
}

export const regenerateSchema = z.object({
  target: z.enum([
    "synopsis",
    "story",
    "elements",
    "character_images",
    "scene_images",
    "voiceover",
    "subtitle_align",
    "render",
  ]),
  direction: z.string().trim().max(2000).optional(),
  /** Voice-design cues, when re-narrating with a different delivery. */
  ttsInstruct: z.string().trim().max(1000).optional(),
  /** Scopes an "elements" or "scene_images" redo to one scene. */
  sceneId: z.string().optional(),
  /** Scopes a "character_images" redo to one character. */
  characterId: z.string().optional(),
});

/**
 * Re-run one stage, optionally under a user's direction.
 *
 * Clears `awaitingReview` so the project is live again — otherwise a project
 * parked for review would stay flagged while a job for it was already running.
 *
 * A `sceneId`/`characterId` scopes the redo to one row rather than the whole
 * stage: its existing artifact is cleared first, which is what makes it the
 * only thing the stage's own "skip what's already there" logic picks up.
 */
export function regenerate(db: Db, projectId: string, input: z.infer<typeof regenerateSchema>) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No such project: ${projectId}`);

  // A story redo rewrites the narration, so the scenes grouped from the old
  // story are stale — `runElements` only groups sentences into scenes when
  // none exist yet (resumability for retries), which otherwise left last
  // run's captions on screen after a "redo story" that changed the text.
  if (input.target === "story") {
    db.delete(scenes).where(eq(scenes.projectId, projectId)).run();
  }

  if (input.target === "elements" && input.sceneId) {
    db.update(scenes)
      .set({ imagePrompt: null, storyboard: null })
      .where(eq(scenes.id, input.sceneId))
      .run();
  }
  if (input.target === "scene_images" && input.sceneId) {
    db.update(scenes).set({ imageAssetId: null }).where(eq(scenes.id, input.sceneId)).run();
  }
  if (input.target === "character_images" && input.characterId) {
    // A redo on a previously-uploaded character (a "revert to generated")
    // must clear imageSource back to its default too, or the character would
    // keep looking "uploaded" — and stay excluded from character_images'
    // pending filter — even after its upload was discarded.
    db.update(characters)
      .set({ imageAssetId: null, imagePrompt: null, refInputName: null, imageSource: "generated" })
      .where(eq(characters.id, input.characterId))
      .run();
  }

  db.update(projects)
    .set({ awaitingReview: false, failureReason: null })
    .where(eq(projects.id, projectId))
    .run();

  return enqueue(db, {
    type: input.target,
    projectId,
    payload: {
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.ttsInstruct ? { ttsInstruct: input.ttsInstruct } : {}),
      ...(input.sceneId ? { sceneId: input.sceneId } : {}),
      ...(input.characterId ? { characterId: input.characterId } : {}),
    },
  });
}
