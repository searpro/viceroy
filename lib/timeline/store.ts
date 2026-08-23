/**
 * The database-facing half of the production timeline (M7.2).
 *
 * `build.ts` is pure and knows nothing about Drizzle; this module is the one
 * place that turns rows into a `Timeline` and applies edits back. Keeping the
 * split means the interesting arithmetic — prefix sums, quantisation, target
 * compilation — is testable without a database, and everything here is
 * ordinary CRUD.
 */

import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  assets,
  locations,
  projects,
  props,
  shotListItems,
  storyboardPanels,
  timelineSegments,
  timelines,
} from "../db/schema";
import { resolveConfig } from "../config";
import { aspectRatioValue, dimensionsForAspect, projectAspect, resolvePresetDimensions } from "../resolution";
import { buildTimeline, type TimelineSegmentRow } from "./build";
import { findTarget, resolveTarget, TIMELINE_TARGETS, TIMELINE_TARGET_IDS } from "./targets";
import type { Timeline, TimelineIssue } from "./types";

/**
 * The longest a single segment may be set to, whatever the target allows.
 *
 * A guard against a typo (60000 for 6000), not a model constraint — those
 * come from `TimelineTarget.constraints` and are reported by `validate()` so
 * the user can see and fix them, rather than being silently refused here.
 */
const MAX_SEGMENT_MS = 120_000;
const MIN_SEGMENT_MS = 100;

export const timelineSettingsPatchSchema = z
  .object({
    targetId: z.enum(TIMELINE_TARGET_IDS as [string, ...string[]]),
    // Not restricted to the target's own `fpsChoices`: a rate the target
    // cannot emit is a warning on the review screen, not a rejected request.
    // Refusing it here would leave a user unable to describe what they want
    // before choosing the target that supports it.
    fps: z.number().int().min(1).max(120),
    globalPrompt: z.string().max(4000),
  })
  .partial();

export const timelineSegmentPatchSchema = z
  .object({
    label: z.string().trim().max(200),
    durationMs: z.number().int().min(MIN_SEGMENT_MS).max(MAX_SEGMENT_MS),
    videoPrompt: z.string().max(4000),
    startKeyframeAssetId: z.string().nullable(),
    endKeyframeAssetId: z.string().nullable(),
    guideStrength: z.number().min(0).max(1),
    // M7.2 — the audio register a human fills in on the review screen, since
    // nothing upstream describes a scene's soundscape in structured form.
    ambience: z.string().max(500),
    foley: z.string().max(500),
    music: z.string().max(500),
    notes: z.string().max(2000),
  })
  .partial();

// `dialogue` is deliberately absent. The words belong to the screenplay,
// which is their single owner: a line edited here would silently disagree
// with the artifact it came from, and — because those exact words are what a
// caption displays after LTX speaks them — the caption would then disagree
// with the audio. Changing what someone says is a screenplay redo. Changing
// how long they have to say it is `durationMs`, right above, which is what
// the "line would be cut off" validation actually asks for.

export type TimelineSettingsPatch = z.infer<typeof timelineSettingsPatchSchema>;
export type TimelineSegmentPatch = z.infer<typeof timelineSegmentPatchSchema>;

/** The stored rows, as the neutral `Timeline`. Undefined until the stage has run. */
export function loadTimeline(db: Db, projectId: string): Timeline | undefined {
  const row = db.select().from(timelines).where(eq(timelines.projectId, projectId)).get();
  if (!row) return undefined;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) return undefined;

  const segments = db
    .select()
    .from(timelineSegments)
    .where(eq(timelineSegments.projectId, projectId))
    .orderBy(asc(timelineSegments.index))
    .all();

  // The project's own delivery size, not the source-frame size the keyframes
  // were generated at: a timeline describes the finished film. Falls back the
  // same way render.ts does for a project predating those columns — through
  // `projectAspect`, so a movie with no stored shape falls back to landscape
  // rather than to the shorts pipeline's vertical.
  const aspectRatio = projectAspect(project);
  const fallback = resolvePresetDimensions(resolveConfig(), undefined, aspectRatio);
  const frame = frameForTarget(
    project.width ?? fallback.width,
    project.height ?? fallback.height,
    aspectRatio,
    row.targetId,
  );

  return buildTimeline(
    {
      projectId,
      targetId: row.targetId,
      fps: row.fps,
      width: frame.width,
      height: frame.height,
      aspectRatio,
      globalPrompt: row.globalPrompt,
      // Null until the Development chain generates narration of its own —
      // see `Timeline["audio"]`'s own comment (types.ts).
      audio: null,
    },
    segments.map(toSegmentRow),
  );
}

/**
 * The project's delivery size, re-cut to whatever grid the target insists on.
 *
 * The project stores width/height on the encoder's multiple-of-2 grid, which
 * is right for Remotion and wrong for a diffusion target: LTX refuses anything
 * that is not a multiple of 32, so every movie project reached the timeline
 * screen reporting "Width 1080 is not a multiple of 32" — an error the user
 * could see and had no control to fix, since the frame is derived and not an
 * editable field.
 *
 * Re-cut rather than rounded. Nudging 1080 up to 1088 keeps the width and
 * changes the *shape*, which is the silent quality loss `resolveConfig`'s own
 * source-vs-video guard exists to prevent; `dimensionsForAspect` instead finds
 * the best-fitting pair on the target's grid at the same pixel budget, so the
 * ratio survives and the size moves.
 *
 * `validate()` still runs and still owns the verdict — this only stops the
 * timeline from being born failing a rule the target stated up front. That is
 * also why a failed re-cut hands back the stored size rather than propagating:
 * `dimensionsForAspect` throws when no size on the grid lands within its pixel
 * tolerance, and `loadTimeline` is called by `getProjectDetail`, so a throw
 * here would 500 the whole project page over a frame the target is perfectly
 * capable of complaining about itself.
 */
function frameForTarget(
  width: number,
  height: number,
  aspectRatio: string,
  targetId: string,
): { width: number; height: number } {
  const multiple = findTarget(targetId)?.constraints.dimensionMultiple;
  if (!multiple || (width % multiple === 0 && height % multiple === 0)) return { width, height };
  try {
    return dimensionsForAspect(aspectRatioValue(aspectRatio, "16:9"), width * height, multiple);
  } catch {
    return { width, height };
  }
}

/**
 * What the review screen needs to know about every registered target.
 *
 * Served with the detail payload rather than imported by the client, so the
 * screen renders fps choices, ceilings and capability flags without importing
 * the registry — which is what keeps "add a target" a server-side change.
 */
export function timelineTargetOptions() {
  return TIMELINE_TARGETS.map((target) => ({
    id: target.id,
    label: target.label,
    constraints: target.constraints,
  }));
}

/**
 * This timeline's problems, according to its own target.
 *
 * Computed here rather than in the component for the same reason: the rules
 * belong to the target, and a screen that reimplemented them would drift from
 * whatever the compiler actually does.
 */
export function timelineIssues(timeline: Timeline | undefined): TimelineIssue[] {
  if (!timeline) return [];
  const target = findTarget(timeline.targetId);
  // A stored id the registry no longer carries is itself the problem worth
  // reporting — better than throwing and taking the whole detail route down.
  if (!target) {
    return [
      {
        severity: "error",
        segmentIndex: null,
        message: `This timeline targets "${timeline.targetId}", which no longer exists. Pick another target.`,
      },
    ];
  }
  return target.validate(timeline);
}

/** Whether this project has reached the timeline stage at all. */
export function hasTimeline(db: Db, projectId: string): boolean {
  return Boolean(db.select().from(timelines).where(eq(timelines.projectId, projectId)).get());
}

export function updateTimelineSettings(
  db: Db,
  projectId: string,
  patch: TimelineSettingsPatch,
): Timeline {
  const row = db.select().from(timelines).where(eq(timelines.projectId, projectId)).get();
  if (!row) throw new Error(`Project ${projectId} has no timeline`);
  // Throws by name on an id the registry no longer carries, which a plain
  // enum check on stored data would not.
  if (patch.targetId !== undefined) resolveTarget(patch.targetId);

  db.update(timelines).set({ ...patch, updatedAt: new Date() }).where(eq(timelines.id, row.id)).run();
  return loadTimeline(db, projectId)!;
}

export function updateTimelineSegment(
  db: Db,
  projectId: string,
  segmentId: string,
  patch: TimelineSegmentPatch,
): Timeline {
  const segment = db.select().from(timelineSegments).where(eq(timelineSegments.id, segmentId)).get();
  // The project check is the access control, not a sanity check: without it,
  // any segment id would be editable through any project's route.
  if (!segment || segment.projectId !== projectId) {
    throw new Error(`No such timeline segment: ${segmentId}`);
  }

  for (const key of ["startKeyframeAssetId", "endKeyframeAssetId"] as const) {
    const assetId = patch[key];
    if (assetId) assertProjectAsset(db, projectId, assetId);
  }

  db.update(timelineSegments)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(timelineSegments.id, segmentId))
    .run();
  return loadTimeline(db, projectId)!;
}

/**
 * Every image this project could use as a keyframe.
 *
 * Gathered from the rows that *reference* an asset, not from the `assets`
 * table itself — `storeAsset` uses `projectId` only to choose a directory and
 * never records it on the row, so `assets` carries no project column to filter
 * on. (An earlier version of this function filtered on `meta.projectId`,
 * matched nothing on real data, and was only caught by looking at the screen:
 * the picker showed "none" for a segment that plainly had a keyframe.)
 *
 * Deriving the set this way is better than parsing the output path anyway,
 * because it answers the question actually being asked — which images belong
 * to this project's story — and it can label each one meaningfully instead of
 * echoing a filename.
 *
 * Cast portraits and reference-pack views are deliberately excluded: those are
 * 512x512 images generated only to be conditioned *on* (M7.1 PR-A3), not
 * frames, and offering eight of them per character would bury the handful of
 * real candidates.
 */
export function projectImageAssets(db: Db, projectId: string): { id: string; label: string }[] {
  const candidates: { id: string | null; label: string }[] = [
    ...db
      .select()
      .from(shotListItems)
      .where(eq(shotListItems.projectId, projectId))
      .orderBy(asc(shotListItems.index))
      .all()
      .map((row) => ({ id: row.keyframeAssetId, label: `Scene ${row.sceneId} · shot ${row.index + 1}` })),
    ...db
      .select()
      .from(storyboardPanels)
      .where(eq(storyboardPanels.projectId, projectId))
      .orderBy(asc(storyboardPanels.index))
      .all()
      .map((row) => ({ id: row.panelImageAssetId, label: `Scene ${row.sceneId} · panel ${row.index + 1}` })),
    ...db
      .select()
      .from(locations)
      .where(eq(locations.projectId, projectId))
      .all()
      .map((row) => ({ id: row.imageAssetId, label: `Location: ${row.name}` })),
    ...db
      .select()
      .from(props)
      .where(eq(props.projectId, projectId))
      .all()
      .map((row) => ({ id: row.imageAssetId, label: `Prop: ${row.name}` })),
  ];

  // A shot list item's keyframe defaults to its source panel's own image, so
  // the same asset legitimately appears twice. First label wins, which is why
  // shots are listed first: a timeline segment is a shot.
  const byId = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.id && !byId.has(candidate.id)) byId.set(candidate.id, candidate.label);
  }
  return [...byId].map(([id, label]) => ({ id, label }));
}

function assertProjectAsset(db: Db, projectId: string, assetId: string): void {
  const asset = db.select().from(assets).where(eq(assets.id, assetId)).get();
  if (!asset) throw new Error(`No such asset: ${assetId}`);
  if (asset.kind !== "image") throw new Error(`Asset ${assetId} is not an image`);
  // The same set the picker offers, so a screen can never show an option the
  // server would refuse — and no other project's asset id is reachable.
  if (!projectImageAssets(db, projectId).some((candidate) => candidate.id === assetId)) {
    throw new Error(`Asset ${assetId} does not belong to project ${projectId}`);
  }
}

function toSegmentRow(row: typeof timelineSegments.$inferSelect): TimelineSegmentRow {
  return {
    id: row.id,
    index: row.index,
    sceneId: row.sceneId,
    label: row.label,
    durationMs: row.durationMs,
    videoPrompt: row.videoPrompt,
    keyframePrompt: row.keyframePrompt,
    startKeyframeAssetId: row.startKeyframeAssetId,
    endKeyframeAssetId: row.endKeyframeAssetId,
    guideStrength: row.guideStrength,
    dialogue: row.dialogue,
    ambience: row.ambience,
    foley: row.foley,
    music: row.music,
    camera: {
      shotType: row.shotType,
      angle: row.cameraAngle,
      movement: row.cameraMovement,
      lens: row.lens,
    },
    characterIds: row.characterIds,
    notes: row.notes,
  };
}
