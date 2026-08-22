import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  characters,
  DEV_CHAIN_STAGES,
  devArtifacts,
  evaluations,
  projects,
  renders,
  scenes,
  subtitleCues,
  voiceovers,
  worldBuilding,
  type DevChainStage,
  type JobType,
} from "../db/schema";
import { enqueue, listJobs } from "../queue";

export type NextStep =
  | { kind: "run"; type: JobType; reason: string }
  // `needsApproval` distinguishes "nothing generated for this stage yet" from
  // "a draft exists but hasn't been approved" — `advance` needs to tell those
  // apart to decide whether the right move is to enqueue generation or to
  // approve what's already there and move on. See `advance` below.
  | { kind: "dev"; stage: DevChainStage; needsApproval: boolean; reason: string }
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

type DevStageStatus = "empty" | "pending" | "approved";

/**
 * Where one dev-chain stage stands.
 *
 * "empty" (nothing generated), "pending" (a draft exists but hasn't been
 * approved) and "approved" collapse three different row shapes — a
 * `dev_artifacts` row, a `characters`+`charactersApprovedAt` pair, or a
 * `world_building` row — into the one three-way answer `devNextStep` and
 * `advance` both need, without either of them caring which of the three a
 * given stage actually is.
 */
function devStageStatus(db: Db, projectId: string, stage: DevChainStage): DevStageStatus {
  if (stage === "characters") {
    // A cast with no characters is legitimate for the narrative pipeline
    // (some narration depicts nobody) but not here: this stage's whole job is
    // to invent the cast, so no rows at all means it hasn't run yet.
    const cast = db.select().from(characters).where(eq(characters.projectId, projectId)).all();
    if (cast.length === 0) return "empty";
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    return project?.charactersApprovedAt ? "approved" : "pending";
  }

  if (stage === "world_building") {
    const row = db.select().from(worldBuilding).where(eq(worldBuilding.projectId, projectId)).get();
    if (!row || !row.content) return "empty";
    return row.approvedAt ? "approved" : "pending";
  }

  const latest = db
    .select()
    .from(devArtifacts)
    .where(and(eq(devArtifacts.projectId, projectId), eq(devArtifacts.stage, stage)))
    .orderBy(desc(devArtifacts.version))
    .get();
  if (!latest || !latest.content) return "empty";
  return latest.approvedAt ? "approved" : "pending";
}

/**
 * `nextStep`'s Development-chain counterpart, walking `DEV_CHAIN_STAGES` in
 * order exactly the way `nextStep` walks its own stage sequence: the first
 * stage that isn't approved is next, whichever of the three row shapes
 * `devStageStatus` finds it in. A `dev_artifacts` stage can have several
 * versions (each redo is a new one, per ADR 0003's "leave the redone stage's
 * own output alone" — see `invalidateDownstreamOf`), so "approved" means the
 * *latest* version is, which is what `devStageStatus` checks.
 *
 * PR2+PR3's seven stages (concept through treatment) have generation logic;
 * PR4+ is what makes the terminal `complete` below reachable.
 */
function devNextStep(db: Db, projectId: string): NextStep {
  for (const stage of DEV_CHAIN_STAGES) {
    const status = devStageStatus(db, projectId, stage);
    if (status === "approved") continue;
    return {
      kind: "dev",
      stage,
      needsApproval: status === "pending",
      reason:
        status === "pending" ? `${stage} is waiting for review` : `${stage} has not been generated yet`,
    };
  }
  // "Development approved, ready for Preproduction" was accurate while
  // `DEV_CHAIN_STAGES` ended at `story_bible` (PR1-5) — once Preproduction
  // PRs started appending their own stage names after it (PR6+), reaching
  // the end of the (growing) list stopped meaning "Development is done" and
  // started meaning "everything currently built is done," which are
  // different claims once any Preproduction stage exists. `story_bible` is
  // still the one fixed point that always means Development specifically
  // finished; the message names it as long as it's the last stage this
  // project actually walked, and stays generic once later stages exist too.
  const lastStage = DEV_CHAIN_STAGES[DEV_CHAIN_STAGES.length - 1];
  return {
    kind: "complete",
    reason:
      lastStage === "story_bible"
        ? "Development approved, ready for Preproduction"
        : "every Development/Preproduction stage built so far is approved",
  };
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
/**
 * Mark a dev-chain stage's current draft approved, without touching its
 * content — mirrors `dev_artifacts.approvedAt` for the two stages that aren't
 * `dev_artifacts` rows (see `devStageStatus`). Idempotent: called only when
 * `devStageStatus` has already reported "pending", but safe to call twice.
 */
function approveDevStage(db: Db, projectId: string, stage: DevChainStage): void {
  if (stage === "characters") {
    db.update(projects).set({ charactersApprovedAt: new Date() }).where(eq(projects.id, projectId)).run();
    return;
  }
  if (stage === "world_building") {
    db.update(worldBuilding)
      .set({ approvedAt: new Date() })
      .where(eq(worldBuilding.projectId, projectId))
      .run();
    return;
  }
  db.update(devArtifacts)
    .set({ approvedAt: new Date() })
    .where(and(eq(devArtifacts.projectId, projectId), eq(devArtifacts.stage, stage)))
    .run();
}

/**
 * Queue whatever comes next, and take the project off the review shelf.
 *
 * This is what "approve and continue" does in manual mode, and what rescues a
 * stalled project. It never guesses past a missing artifact — `nextStep` only
 * ever names work that is genuinely outstanding.
 *
 * For the Development chain (M7 PR2) "continue" does double duty, per the
 * API route's own doc comment: if the next stage already has a draft waiting
 * on review, this approves it first — that's the "approve" half — and only
 * then re-derives what comes after and dispatches it, the same as any other
 * outstanding work. A manual-mode dev project therefore advances one stage
 * per click, exactly like the narrative pipeline's own manual mode.
 */
export function advance(db: Db, projectId: string): NextStep {
  const step = nextStep(db, projectId);
  if (step.kind === "complete") return step;

  db.update(projects)
    .set({ awaitingReview: false, failureReason: null })
    .where(eq(projects.id, projectId))
    .run();

  if (step.kind === "run") {
    enqueue(db, { type: step.type, projectId });
    return step;
  }

  if (step.needsApproval) {
    approveDevStage(db, projectId, step.stage);
    return advance(db, projectId);
  }

  enqueue(db, { type: step.stage, projectId });
  return step;
}
