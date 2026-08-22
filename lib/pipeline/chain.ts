import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  characters,
  DEV_ARTIFACT_STAGES,
  devArtifacts,
  evaluations,
  projects,
  renders,
  scenes,
  subtitleCues,
  voiceovers,
  type DevArtifactStage,
  type JobType,
} from "../db/schema";
import { enqueue, listJobs } from "../queue";

export type NextStep =
  | { kind: "run"; type: JobType; reason: string }
  | { kind: "dev"; stage: DevArtifactStage; reason: string }
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

  // `short_video_narrative` (and any row that predates this column) runs the
  // body below completely unchanged — same code path, same jobs. Every other
  // format is the Development chain's project, worked out from a different
  // set of artifacts entirely.
  if (project.format !== "short_video_narrative") return devNextStep(db, projectId);

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

  // Every other artifact above answers "does this exist"; a render is the one
  // whose existence does not imply it is current. Without this check, a
  // project whose upstream was regenerated reports `complete` and hands the
  // user back the previous video — and manual mode reaches this line by
  // clicking Continue, where nothing else would re-enqueue the render.
  const newestInput = Math.max(
    ...sceneRows.map((scene) => scene.updatedAt.getTime()),
    voiceover.updatedAt.getTime(),
    ...cues.map((cue) => cue.createdAt.getTime()),
  );
  if (newestInput > ready.createdAt.getTime()) {
    return { kind: "run", type: "render", reason: "the video is older than the scenes it was built from" };
  }

  return { kind: "complete", reason: "the video is rendered" };
}

/**
 * `nextStep`'s Development-chain counterpart, walking `DEV_ARTIFACT_STAGES`
 * in order exactly the way `nextStep` walks its own stage sequence: the
 * first stage with no approved `dev_artifacts` row is next. A stage can have
 * several versions (each redo is a new one, per ADR 0003's "leave the redone
 * stage's own output alone" — see `invalidateDownstreamOf`), so "approved"
 * means *some* version of it is, not the latest one specifically.
 *
 * PR1 only builds this far: no stage has generation logic yet, so a fresh
 * dev-format project always lands on "concept". PR5 is what makes the
 * terminal `complete` below reachable.
 */
function devNextStep(db: Db, projectId: string): NextStep {
  for (const stage of DEV_ARTIFACT_STAGES) {
    const approved = db
      .select()
      .from(devArtifacts)
      .where(
        and(
          eq(devArtifacts.projectId, projectId),
          eq(devArtifacts.stage, stage),
          isNotNull(devArtifacts.approvedAt),
        ),
      )
      .get();
    if (!approved) return { kind: "dev", stage, reason: `${stage} has not been approved yet` };
  }
  return { kind: "complete", reason: "Development approved, ready for Preproduction" };
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

  // A "dev" step has no generation logic to queue yet (PR2+ scope) — PR1
  // only has to route to the right stage, not dispatch work for it.
  if (step.kind === "run") enqueue(db, { type: step.type, projectId });
  return step;
}
