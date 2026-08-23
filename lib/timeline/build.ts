/**
 * Assembling a `Timeline` from rows — pure, and deliberately free of any `Db`
 * handle.
 *
 * Two functions, because there are two moments and they are not the same one:
 * `seedSegments` turns an approved shot list into the segments a timeline
 * starts life with (the stage runs this once), and `buildTimeline` turns
 * stored segment rows plus project settings into the neutral `Timeline`
 * everything else reads. Only the second one derives timecodes, and it is the
 * only place that does.
 */

import { minimumDurationMs, type DialogueLine } from "./speech";
import type { Timeline, TimelineSegment } from "./types";

/**
 * What a shot is worth when its `durationHintMs` is missing.
 *
 * Shared with `runShotList` (which defaults the column) and `runPrevis` (which
 * lays stills out with it), so the timeline and the animatic describe the same
 * arrangement by construction rather than by two constants that happen to
 * agree today.
 */
export const DEFAULT_SEGMENT_DURATION_MS = 4000;

/** The default keyframe pin strength. Full strength: the still is the shot's first frame. */
export const DEFAULT_GUIDE_STRENGTH = 1;

/** The subset of a `shot_list_items` row a timeline is seeded from. */
export type TimelineShotInput = {
  id: string;
  sceneId: string;
  index: number;
  keyframePrompt: string;
  motionPrompt: string;
  shotType: string;
  cameraAngle: string;
  cameraMovement: string;
  lens: string;
  characterIds: string[];
  /** M7.2 — the lines spoken during this shot, from the approved screenplay. */
  dialogue: DialogueLine[];
  durationHintMs: number | null;
  keyframeAssetId: string | null;
};

/** One seeded segment, before it has an id of its own. */
export type SeededSegment = Omit<TimelineSegment, "id" | "startMs"> & {
  shotListItemId: string;
};

/** The stored half of a segment — everything `buildTimeline` cannot derive. */
export type TimelineSegmentRow = Omit<TimelineSegment, "startMs">;

export type TimelineSettings = {
  projectId: string;
  targetId: string;
  fps: number;
  width: number;
  height: number;
  aspectRatio: string;
  globalPrompt: string;
  audio?: Timeline["audio"];
};

/**
 * One segment per shot list item, in the shot list's own order.
 *
 * A 1:1 mapping on purpose: the shot list stays the single answer to "what
 * shots exist", so an upstream redo has one obvious consequence rather than a
 * reconciliation problem. Editing the timeline changes how a shot is rendered,
 * never which shots there are.
 */
export function seedSegments(shots: TimelineShotInput[]): SeededSegment[] {
  return [...shots]
    .sort((a, b) => a.index - b.index)
    .map((shot, position) => ({
      shotListItemId: shot.id,
      index: position,
      sceneId: shot.sceneId,
      label: segmentLabel(shot),
      // The shot list already floors its hint by the speech it carries
      // (`runShotList`), but a hand-edited or pre-M7.2 row may not have, and a
      // segment shorter than its own dialogue is a clip with the end of a line
      // cut off.
      durationMs: Math.max(durationFor(shot.durationHintMs), minimumDurationMs(shot.dialogue)),
      videoPrompt: shot.motionPrompt,
      keyframePrompt: shot.keyframePrompt,
      startKeyframeAssetId: shot.keyframeAssetId,
      // Nothing in Preproduction produces an "arrive at this frame" still, and
      // inventing one by borrowing the next shot's keyframe would assert a
      // continuity the cut does not have. Left for a human to pick.
      endKeyframeAssetId: null,
      guideStrength: DEFAULT_GUIDE_STRENGTH,
      dialogue: shot.dialogue,
      // Empty rather than invented. Nothing upstream describes a scene's
      // soundscape in structured form, and a guess here would be a guess
      // baked into every generated clip — the review screen is where a human
      // fills these in, which is what the stage exists to make possible.
      ambience: "",
      foley: "",
      music: "",
      camera: {
        shotType: shot.shotType,
        angle: shot.cameraAngle,
        movement: shot.cameraMovement,
        lens: shot.lens,
      },
      characterIds: shot.characterIds,
      notes: "",
    }));
}

/**
 * Stored rows plus settings → the neutral timeline.
 *
 * `startMs` and `totalDurationMs` are computed here and nowhere else. Rows are
 * sorted by `index` first: the caller's ordering is not trusted, because a
 * timecode derived from an accidental ordering is wrong in a way that looks
 * right.
 */
export function buildTimeline(
  settings: TimelineSettings,
  rows: TimelineSegmentRow[],
): Timeline {
  const ordered = [...rows].sort((a, b) => a.index - b.index);

  let elapsed = 0;
  const segments: TimelineSegment[] = ordered.map((row) => {
    const segment: TimelineSegment = { ...row, startMs: elapsed };
    elapsed += row.durationMs;
    return segment;
  });

  return {
    projectId: settings.projectId,
    targetId: settings.targetId,
    fps: settings.fps,
    width: settings.width,
    height: settings.height,
    aspectRatio: settings.aspectRatio,
    globalPrompt: settings.globalPrompt,
    totalDurationMs: elapsed,
    segments,
    audio: settings.audio ?? null,
  };
}

/** The end of a segment, in the timeline's own clock. */
export function segmentEndMs(segment: TimelineSegment): number {
  return segment.startMs + segment.durationMs;
}

function durationFor(hint: number | null): number {
  if (typeof hint !== "number" || !Number.isFinite(hint) || hint <= 0) {
    return DEFAULT_SEGMENT_DURATION_MS;
  }
  return Math.round(hint);
}

function segmentLabel(shot: TimelineShotInput): string {
  const scene = shot.sceneId.trim();
  const shotType = shot.shotType.trim();
  if (scene && shotType) return `Scene ${scene} · ${shotType}`;
  if (scene) return `Scene ${scene}`;
  return shotType || `Shot ${shot.index + 1}`;
}
