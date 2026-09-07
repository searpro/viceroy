import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  characters,
  continuityFacts,
  DEV_CHAIN_STAGES,
  devArtifacts,
  evaluations,
  locations,
  projects,
  props,
  renders,
  sceneShots,
  scenes,
  shotListItems,
  storyboardPanels,
  subtitleCues,
  timelines,
  timelineSegments,
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
  // Two shapes are legal here. A project visualised before M9 has a scene-level
  // `imagePrompt` and no `visualBrief`; one visualised after has the reverse,
  // plus a row in `scene_shots` per picture. Either counts as "this scene has
  // been visualised" — the alternative is re-running element extraction on
  // every finished project the day M9 landed.
  if (sceneRows.some((scene) => !scene.visualBrief && !scene.imagePrompt)) {
    return { kind: "run", type: "elements", reason: "some scenes have not been visualised" };
  }

  const shotRows = db.select().from(sceneShots).where(eq(sceneShots.projectId, projectId)).all();
  const coveredScenes = new Set(shotRows.map((shot) => shot.sceneId));

  // A scene with no shots still needs covering — unless it is a pre-M9 project
  // that already has every one of its single stills, which is left exactly as
  // it is. Covering it would throw away pictures that already exist.
  //
  // Deliberately narrow: an *intact* pre-M9 project is preserved, and one that
  // has lost an image is upgraded to shots instead, because at that point
  // there is nothing left to preserve. That keeps this the only place in the
  // pipeline that has to know the old shape — `runSceneImages` never sees it,
  // and only `renderShots` needs a fallback, for viewing and re-rendering a
  // finished project.
  const legacy = sceneRows.every((scene) => !coveredScenes.has(scene.id) && scene.imageAssetId);
  if (!legacy && sceneRows.some((scene) => !coveredScenes.has(scene.id))) {
    return { kind: "run", type: "elements", reason: "some scenes have no shots" };
  }
  if (shotRows.some((shot) => !shot.imagePrompt)) {
    return { kind: "run", type: "elements", reason: "some shots have no image prompt" };
  }

  const cast = db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  if (cast.some((character) => !character.imageAssetId)) {
    return { kind: "run", type: "character_images", reason: "some characters have no portrait" };
  }

  const imageless = legacy
    ? sceneRows.some((scene) => !scene.imageAssetId)
    : shotRows.some((shot) => !shot.imageAssetId);
  if (imageless) {
    return { kind: "run", type: "scene_images", reason: "some shots have no image" };
  }

  const voiceover = db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get();
  if (!voiceover?.audioAssetId) {
    return { kind: "run", type: "voiceover", reason: "the narration has not been generated" };
  }

  const cues = db.select().from(subtitleCues).where(eq(subtitleCues.projectId, projectId)).all();
  const untimed = legacy
    ? sceneRows.some((scene) => scene.startMs === null)
    : shotRows.some((shot) => shot.startMs === null);
  if (cues.length === 0 || untimed) {
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
    // A re-rolled shot is a changed input to the render exactly as a re-rolled
    // scene was — its scene row is not touched, so without this a one-shot redo
    // would report `complete` and hand back the previous video.
    ...shotRows.map((shot) => shot.updatedAt.getTime()),
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

  if (stage === "continuity") {
    // Zero rows means the extraction hasn't run — `runContinuity` throws
    // rather than leaving no facts behind on a genuine run (mirrors
    // `runDevCharacters`'s "no usable characters" throw), so this can't be
    // confused with "ran, found nothing worth recording". "Approved" is
    // deliberately not gated on every conflict being resolved — see
    // `runContinuity`'s own doc comment (dev.ts) for why.
    const facts = db.select({ id: continuityFacts.id }).from(continuityFacts).where(eq(continuityFacts.projectId, projectId)).all();
    if (facts.length === 0) return "empty";
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    return project?.continuityApprovedAt ? "approved" : "pending";
  }

  if (stage === "concept_art") {
    // Unlike "characters" above, a project can legitimately reach this stage
    // with zero locations and zero props (a story that needs none) — that is
    // not "hasn't run yet", it's "nothing to generate", so it is treated as
    // vacuously done rather than forced through a stage that has no work.
    // Otherwise: any location/prop still missing an image means generation
    // has not (fully) run — "empty" is used for that case regardless of
    // whether it's a fresh run or a partial one resuming, since either way
    // `runConceptArt` is what needs to happen next, not an approval click.
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (project?.conceptArtApprovedAt) return "approved";
    const locs = db
      .select({ imageAssetId: locations.imageAssetId })
      .from(locations)
      .where(eq(locations.projectId, projectId))
      .all();
    const items = db
      .select({ imageAssetId: props.imageAssetId })
      .from(props)
      .where(eq(props.projectId, projectId))
      .all();
    const stillPending = [...locs, ...items].some((row) => !row.imageAssetId);
    return stillPending ? "empty" : "pending";
  }

  if (stage === "storyboards") {
    // Unlike "concept_art", there is no cheap "is every panel done" check
    // here — the target panel count is only known after beat extraction runs
    // (an LLM call), not derivable from a fixed row set the way
    // locations/props are. So this is simpler than "concept_art"'s own
    // status check: zero panels means the stage hasn't run yet; any panel at
    // all means it has (a `runStoryboards` retry after a partial failure is
    // still "pending" here, same as any other in-progress table stage) —
    // `runStoryboards` itself is what's resumable, per its own doc comment.
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (project?.storyboardsApprovedAt) return "approved";
    const panels = db
      .select({ id: storyboardPanels.id })
      .from(storyboardPanels)
      .where(eq(storyboardPanels.projectId, projectId))
      .all();
    return panels.length === 0 ? "empty" : "pending";
  }

  if (stage === "shot_list") {
    // Same shape as "storyboards" above, for the same reason: the target row
    // count is only known after this stage's own extraction runs, so it isn't
    // derivable from a fixed set the way `concept_art`'s locations/props are.
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (project?.shotListApprovedAt) return "approved";
    const items = db
      .select({ id: shotListItems.id })
      .from(shotListItems)
      .where(eq(shotListItems.projectId, projectId))
      .all();
    return items.length === 0 ? "empty" : "pending";
  }

  if (stage === "previs") {
    // No "pending" state for this stage, deliberately — unlike every other
    // table stage above, previs produces exactly one artifact per project
    // (the rendered animatic), not many reviewable rows, so there is nothing
    // for a separate approval click to mean beyond "the render exists". See
    // `projects.previsAssetId`'s own comment (schema.ts).
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    return project?.previsAssetId ? "approved" : "empty";
  }

  if (stage === "casting") {
    // Same "no pending state" shape as "previs" above, for the same reason:
    // a character is locked the moment its own portrait exists (see
    // `runCasting`'s own doc comment, dev.ts), so there is nothing left for a
    // separate approval click to mean. Empty until every character in the
    // cast is locked — a cast with zero rows is "empty" too (chain order
    // already guarantees "characters" is approved by the time this stage
    // runs, so that should never actually happen, but reports the honest
    // answer rather than a vacuous "approved" if it somehow does).
    const cast = db
      .select({ castingLockedAt: characters.castingLockedAt })
      .from(characters)
      .where(eq(characters.projectId, projectId))
      .all();
    return cast.length > 0 && cast.every((c) => c.castingLockedAt) ? "approved" : "empty";
  }

  if (stage === "timeline") {
    // Both halves have to be there: `runTimeline` writes the settings row and
    // its segments together, so a settings row with no segments means the
    // stage died mid-write, not that a human is looking at an empty timeline.
    // Reporting that as "pending" would offer an approve button for nothing.
    const row = db.select().from(timelines).where(eq(timelines.projectId, projectId)).get();
    if (!row) return "empty";
    const segments = db
      .select({ id: timelineSegments.id })
      .from(timelineSegments)
      .where(eq(timelineSegments.projectId, projectId))
      .all();
    if (segments.length === 0) return "empty";
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
  // What "the end of the list" means depends on what the last stage is, and
  // the list has now grown twice. `story_bible` was the fixed point that
  // meant *Development* finished (PR1-5); Preproduction's own stages were
  // appended after it (PR6-PR13) and `production_plan` became the fixed point
  // that meant *Preproduction* finished.
  //
  // That entry used to claim it was permanent — "nothing left to append after
  // it" — and M7.2 appended `timeline` anyway. The lesson is the one
  // `story_bible` already taught and this comment talked itself out of: a
  // terminal message is about which stage is last, not about the list being
  // finished. So each known last stage names what it completes, and an
  // unrecognised one falls back to the honest generic claim rather than
  // asserting a phase boundary nobody has defined.
  const lastStage = DEV_CHAIN_STAGES[DEV_CHAIN_STAGES.length - 1];
  return {
    kind: "complete",
    reason:
      lastStage === "timeline"
        ? "Timeline approved, ready for Production"
        : lastStage === "production_plan"
          ? "Preproduction approved, ready for Production"
          : lastStage === "story_bible"
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
  if (stage === "continuity") {
    db.update(projects).set({ continuityApprovedAt: new Date() }).where(eq(projects.id, projectId)).run();
    return;
  }
  if (stage === "concept_art") {
    db.update(projects).set({ conceptArtApprovedAt: new Date() }).where(eq(projects.id, projectId)).run();
    return;
  }
  if (stage === "storyboards") {
    db.update(projects).set({ storyboardsApprovedAt: new Date() }).where(eq(projects.id, projectId)).run();
    return;
  }
  if (stage === "shot_list") {
    db.update(projects).set({ shotListApprovedAt: new Date() }).where(eq(projects.id, projectId)).run();
    return;
  }
  if (stage === "previs") {
    // Never actually called — `devStageStatus` never reports "previs" as
    // "pending" (see its own comment above), so `advance` never reaches this
    // branch for it. Present anyway so `stage` narrows to `DevArtifactStage`
    // by the time it reaches the `devArtifacts` update below.
    return;
  }
  if (stage === "casting") {
    // Never actually called, for the same reason "previs" above never is —
    // `devStageStatus` never reports "casting" as "pending" (see its own
    // comment above).
    return;
  }
  if (stage === "timeline") {
    // Unlike "previs"/"casting" this branch genuinely runs: a timeline has a
    // real pending state, because the whole point of the stage is that a human
    // looks at the arrangement and edits it before signing it off (M7.2).
    db.update(timelines)
      .set({ approvedAt: new Date() })
      .where(eq(timelines.projectId, projectId))
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
