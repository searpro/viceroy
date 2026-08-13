import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
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

export const createProjectSchema = z.object({
  idea: z.string().trim().min(8, "Give the idea a little more to work with").max(2000),
  narrativeStyleId: z.string().optional(),
  voiceStyleId: z.string().optional(),
  imageStyleId: z.string().optional(),
  captionStyleId: z.string().optional(),
  mode: z.enum(["auto", "manual"]).default("auto"),
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

  const [project] = db
    .insert(projects)
    .values({
      idea: input.idea,
      mode: input.mode,
      narrativeStyleId: narrative.id,
      voiceStyleId: voice.id,
      imageStyleId: image.id,
      captionStyleId: caption.id,
    })
    .returning()
    .all();

  enqueue(db, { type: "synopsis", projectId: project!.id });
  return project!;
}

export function listProjects(db: Db) {
  return db.select().from(projects).orderBy(desc(projects.createdAt)).limit(50).all();
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
    db.update(characters)
      .set({ imageAssetId: null, imagePrompt: null, refInputName: null })
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
