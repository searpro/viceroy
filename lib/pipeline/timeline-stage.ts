import { asc, eq } from "drizzle-orm";
import { seedSegments } from "../timeline/build";
import { DEFAULT_TIMELINE_TARGET_ID } from "../timeline/targets";
import { shotListItems, timelineSegments, timelines } from "../db/schema";
import {
  awaitReview,
  loadProject,
  requireProjectId,
  type ProjectBundle,
  type StageContext,
} from "./context";

/**
 * The style register that stays constant across every segment.
 *
 * Assembled from the two owners that already carry it — Image Style's
 * `renderGuidance` (how a frame is rendered) and Production Design Style's
 * visual-language/palette/texture guidance (what the world looks like) — and
 * from no third one. Inventing a "timeline style" here is precisely the
 * failure the Prompt & Flow Audit named as root cause #1 and that both the M7
 * and M8 detail pages warn against repeating: art direction with two owners
 * that never see each other.
 *
 * This is a starting point, not a lock. It is written into an editable column
 * once, at seed time, so a human can rewrite it without their edit being
 * overwritten by a style change later.
 */
function seedGlobalPrompt(bundle: ProjectBundle): string {
  const { imageStyle, productionDesignStyle } = bundle;
  return [
    imageStyle.renderGuidance,
    productionDesignStyle?.visualLanguageGuidance,
    productionDesignStyle?.paletteGuidance,
    productionDesignStyle?.textureGuidance,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(". ");
}

/**
 * Stage 22 (M7.2) — the production timeline.
 *
 * An assembly stage, exactly the shape `runProductionPlan` established for
 * stage 21: no provider is resolved, no sd-api call of any kind is made, no
 * pixel is generated. Everything it needs already exists as approved
 * `shot_list_items` rows. It arranges them.
 *
 * What it adds over the previs, which arranges the same rows: the arrangement
 * survives. `runPrevis` prefix-sums the same durations to lay stills on a
 * Remotion track, then discards the layout along with its staging directory —
 * so nothing downstream can read, review or edit it. This stage writes it
 * down, in a shape no provider owns (`lib/timeline/types.ts`), which is what
 * makes it the handoff artifact M8 consumes.
 *
 * Its own module rather than a 22nd function in `dev.ts`, which is already
 * near three thousand lines and is where the *generation* stages live. This
 * one generates nothing.
 *
 * Deliberately **not** partially resumable the way `runStoryboards` is: a
 * timeline is cheap to rebuild (no GPU, no LLM), and rebuilding wholesale is
 * the only way to guarantee the segment set still matches the current shot
 * list. A run therefore replaces every segment. The settings row survives,
 * because `targetId`/`fps`/`globalPrompt` are the user's choices rather than
 * output — the same split `DISCARD.timeline` (lib/projects.ts) makes.
 */
export async function runTimeline(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const bundle = loadProject(ctx.db, projectId);
  const { project } = bundle;

  const items = ctx.db
    .select()
    .from(shotListItems)
    .where(eq(shotListItems.projectId, projectId))
    .orderBy(asc(shotListItems.index))
    .all();
  if (items.length === 0) {
    throw new Error(`Project ${projectId} has no shot list to build a timeline from`);
  }

  ctx.progress(0.3);

  const seeded = seedSegments(
    items.map((item) => ({
      id: item.id,
      sceneId: item.sceneId,
      index: item.index,
      keyframePrompt: item.keyframePrompt,
      motionPrompt: item.motionPrompt,
      shotType: item.shotType,
      cameraAngle: item.cameraAngle,
      cameraMovement: item.cameraMovement,
      lens: item.lens,
      characterIds: item.characterIds,
      dialogue: item.dialogue,
      durationHintMs: item.durationHintMs,
      keyframeAssetId: item.keyframeAssetId,
    })),
  );
  // The camera fields are closed enums on both tables; `seedSegments` widens
  // them to strings because the neutral timeline type cannot depend on the
  // storyboard vocabulary. Copying them off the source row instead of casting
  // the widened ones back keeps that narrowing real rather than asserted.
  const sourceById = new Map(items.map((item) => [item.id, item]));

  const existing = ctx.db.select().from(timelines).where(eq(timelines.projectId, projectId)).get();
  if (existing) {
    // A rebuild un-approves: the arrangement a human signed off on is not the
    // one that now exists.
    ctx.db
      .update(timelines)
      .set({ approvedAt: null, updatedAt: new Date() })
      .where(eq(timelines.id, existing.id))
      .run();
  } else {
    ctx.db
      .insert(timelines)
      .values({
        projectId,
        targetId: DEFAULT_TIMELINE_TARGET_ID,
        globalPrompt: seedGlobalPrompt(bundle),
      })
      .run();
  }

  ctx.db.delete(timelineSegments).where(eq(timelineSegments.projectId, projectId)).run();
  for (const segment of seeded) {
    const source = sourceById.get(segment.shotListItemId)!;
    ctx.db
      .insert(timelineSegments)
      .values({
        projectId,
        shotListItemId: segment.shotListItemId,
        sceneId: segment.sceneId,
        index: segment.index,
        label: segment.label,
        durationMs: segment.durationMs,
        videoPrompt: segment.videoPrompt,
        keyframePrompt: segment.keyframePrompt,
        startKeyframeAssetId: segment.startKeyframeAssetId,
        endKeyframeAssetId: segment.endKeyframeAssetId,
        guideStrength: segment.guideStrength,
        shotType: source.shotType,
        cameraAngle: source.cameraAngle,
        cameraMovement: source.cameraMovement,
        lens: source.lens,
        characterIds: segment.characterIds,
        dialogue: segment.dialogue,
        ambience: segment.ambience,
        foley: segment.foley,
        music: segment.music,
        notes: segment.notes,
      })
      .run();
  }

  const totalMs = seeded.reduce((sum, segment) => sum + segment.durationMs, 0);
  ctx.log(`Timeline assembled: ${seeded.length} segment(s), ${(totalMs / 1000).toFixed(1)}s total`);

  const missingKeyframes = seeded.filter((segment) => !segment.startKeyframeAssetId).length;
  if (missingKeyframes > 0) {
    // Reported rather than thrown. The target's own `validate()` raises this
    // on the review screen, where a human can fix it by picking a keyframe;
    // failing the stage would leave them nothing to fix it *with*.
    ctx.log(`${missingKeyframes} segment(s) have no start keyframe — review before approving`);
  }
  ctx.progress(1);

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  ctx.log("Timeline is the last stage in the chain — nothing further to enqueue");
}
