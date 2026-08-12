import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  characters,
  evaluations,
  projects,
  renders,
  scenes,
  subtitleCues,
  voiceovers,
  type JobType,
} from "../db/schema";
import { enqueue, listJobs } from "../queue";

export type NextStep =
  | { kind: "run"; type: JobType; reason: string }
  | { kind: "complete"; reason: string };

/**
 * What this project still needs, worked out from what it actually has.
 *
 * Deliberately derived from artifacts rather than from `projects.stage`. A
 * stage label records where a project got to; it cannot say whether the work
 * is still there. Deriving means the answer is self-healing: a project left
 * behind by a chain that did not exist yet, or one whose scene images were
 * deleted, both get a correct next step without anyone repairing a column.
 *
 * That is not hypothetical — two projects were stranded exactly this way, at
 * `scene_images` with every job succeeded, because the stage that should have
 * followed had not been written when they ran.
 */
export function nextStep(db: Db, projectId: string): NextStep {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`No such project: ${projectId}`);

  if (!project.synopsis) return { kind: "run", type: "synopsis", reason: "no synopsis yet" };
  if (!project.story) return { kind: "run", type: "story", reason: "no story yet" };

  const judged = db.select().from(evaluations).where(eq(evaluations.projectId, projectId)).all();
  if (judged.length === 0) {
    return { kind: "run", type: "story_eval", reason: "the story has not been evaluated" };
  }

  const sceneRows = db.select().from(scenes).where(eq(scenes.projectId, projectId)).all();
  if (sceneRows.length === 0) {
    return { kind: "run", type: "elements", reason: "no scenes have been extracted" };
  }
  if (sceneRows.some((scene) => !scene.imagePrompt)) {
    return { kind: "run", type: "elements", reason: "some scenes have no image prompt" };
  }

  const cast = db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  if (cast.some((character) => !character.imageAssetId)) {
    return { kind: "run", type: "character_images", reason: "some characters have no portrait" };
  }

  if (sceneRows.some((scene) => !scene.imageAssetId)) {
    return { kind: "run", type: "scene_images", reason: "some scenes have no image" };
  }

  const voiceover = db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get();
  if (!voiceover?.audioAssetId) {
    return { kind: "run", type: "voiceover", reason: "the narration has not been generated" };
  }

  const cues = db.select().from(subtitleCues).where(eq(subtitleCues.projectId, projectId)).all();
  if (cues.length === 0 || sceneRows.some((scene) => scene.startMs === null)) {
    return { kind: "run", type: "subtitle_align", reason: "captions have not been aligned" };
  }

  const ready = db
    .select()
    .from(renders)
    .where(and(eq(renders.projectId, projectId), eq(renders.status, "ready")))
    .get();
  if (!ready) return { kind: "run", type: "render", reason: "no finished video" };

  return { kind: "complete", reason: "the video is rendered" };
}

/**
 * A project that will never move on its own.
 *
 * Nothing is queued or running for it, it is not parked for review, and it is
 * not finished — so no worker will touch it and no screen is asking anyone to.
 * Without surfacing this, such a project reads as "in progress" indefinitely.
 */
export function isStalled(db: Db, projectId: string): boolean {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project || project.awaitingReview) return false;

  const active = listJobs(db, { projectId }).some(
    (job) => job.status === "queued" || job.status === "running",
  );
  if (active) return false;

  return nextStep(db, projectId).kind === "run";
}

/**
 * Queue whatever comes next, and take the project off the review shelf.
 *
 * This is what "approve and continue" does in manual mode, and what rescues a
 * stalled project. It never guesses past a missing artifact — `nextStep` only
 * ever names work that is genuinely outstanding.
 */
export function advance(db: Db, projectId: string): NextStep {
  const step = nextStep(db, projectId);
  if (step.kind === "complete") return step;

  db.update(projects)
    .set({ awaitingReview: false, failureReason: null })
    .where(eq(projects.id, projectId))
    .run();

  enqueue(db, { type: step.type, projectId });
  return step;
}
