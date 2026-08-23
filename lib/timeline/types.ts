/**
 * The production timeline — the artifact that stands between Preproduction and
 * Production (M7.2).
 *
 * Everything Preproduction produces describes *what a shot is*: its prompts,
 * its camera, its keyframe, a duration hint. Nothing until now described *what
 * occupies which span of the finished film*. `runPrevis` assembles that
 * arrangement implicitly, lays stills on a Remotion track with it, and throws
 * it away. This module makes it a real thing: an ordered set of segments with
 * derived timecodes, reviewable and editable before any GPU time is spent.
 *
 * **Not to be confused with `remotion/timeline.ts`**, which is about caption
 * cues (`activeCueAt`) and shares nothing with this beyond the word.
 *
 * The shape here is deliberately nobody's native format. LTX Director is the
 * current production target, but Wan and Minimax expose comparable
 * segment/keyframe primitives, and the M8 detail page's own risk list warns
 * against letting one provider's vocabulary leak upward. A `TimelineTarget`
 * (below) is the only thing that knows what a provider calls any of this.
 */

import type { FrameQuantum } from "./frames";
import type { DialogueLine } from "./speech";

/**
 * One planned clip.
 *
 * `startMs` is **derived, never stored** — it is the prefix sum of every
 * earlier segment's `durationMs`, recomputed on read. Persisting it would let
 * an edited duration leave a stale offset behind two segments later, which is
 * the same class of "stored label disagrees with the artifacts" failure
 * `nextStep()` avoids by deriving instead of recording.
 */
export type TimelineSegment = {
  id: string;
  /** Project-wide order, matching `shot_list_items.index`. */
  index: number;
  /** Free text, not a `scenes` FK — same reasoning as `shotListItems.sceneId`. */
  sceneId: string;
  /** Human-readable, for the track UI: "Scene 3 · wide". */
  label: string;
  /** Derived: the prefix sum of every earlier segment's duration. */
  startMs: number;
  durationMs: number;
  /**
   * The motion register — what the camera and subject do over the segment.
   * Seeded from `shotListItems.motionPrompt`; kept distinct from
   * `keyframePrompt` for the reason M8 detail's prompt-engine section gives:
   * a model asked for one field tends to describe only the frame.
   */
  videoPrompt: string;
  /** The still register, carried for display and provenance. Never compiled. */
  keyframePrompt: string;
  startKeyframeAssetId: string | null;
  /**
   * The frame the segment should arrive at, for a target that does
   * first/last-frame conditioning. Null means "unconstrained ending", which is
   * what every segment means until someone picks one.
   */
  endKeyframeAssetId: string | null;
  /** 0..1 — how hard the keyframe pins generation. */
  guideStrength: number;
  /**
   * The audio register (M7.2), stored as components rather than prose.
   *
   * LTX generates sound in the same pass as picture, and takes its direction
   * from the video prompt: ambience, foley and music named in plain language,
   * with spoken lines in quotation marks. Composing that paragraph is the
   * *target's* job (`ltx-director.ts`) — storing it here would make the
   * timeline LTX's format, and a target that took a separate audio track
   * would want these same components nowhere near the video prompt.
   */
  dialogue: DialogueLine[];
  /** The ambient bed: the space itself, not an event in it. */
  ambience: string;
  /** Sounds tied to motion. "Specific beats generic." */
  foley: string;
  /** Genre, instrumentation, tempo, mood — or empty for no score. */
  music: string;
  camera: { shotType: string; angle: string; movement: string; lens: string };
  characterIds: string[];
  notes: string;
};

export type Timeline = {
  projectId: string;
  targetId: string;
  fps: number;
  width: number;
  height: number;
  aspectRatio: string;
  /** Style and persistent world/character anchor, applied across every segment. */
  globalPrompt: string;
  /** Derived: the sum of every segment's duration. */
  totalDurationMs: number;
  segments: TimelineSegment[];
  /**
   * A supplied audio track, replacing whatever the target would generate.
   *
   * Null is the *primary* path, not a placeholder: the target generates
   * dialogue and sound itself from each segment's own audio register (see
   * `TimelineSegment.dialogue`). Kept in the type because a target that
   * cannot generate audio, or a project that later wants an authored
   * narration bed under a dialogue-led film, needs somewhere to put one —
   * and because `supportsCustomAudio` is only meaningful against a field that
   * exists.
   */
  audio: { assetId: string; durationMs: number } | null;
};

/**
 * What a target can and cannot do, as data.
 *
 * This is what decouples the review UI from the provider: the screen renders
 * warnings, fps choices and ceilings out of this record without ever naming
 * LTX. A second target is a new file plus a registry entry — no UI change.
 */
export type TimelineConstraints = {
  fpsChoices: readonly number[];
  /** Null means the target accepts any whole frame count. */
  frameQuantum: FrameQuantum | null;
  /** Generation dimensions must be a multiple of this. LTX: 32. */
  dimensionMultiple: number;
  /** The longest single pass this target will produce. */
  maxSegmentMs: number;
  /** Null means the target has no ceiling of its own on total length. */
  maxTotalMs: number | null;
  maxSegments: number | null;
  supportsEndKeyframe: boolean;
  supportsGlobalPrompt: boolean;
  supportsCustomAudio: boolean;
};

export type TimelineIssue = {
  severity: "error" | "warning";
  /** Null for a whole-timeline problem rather than one segment's. */
  segmentIndex: number | null;
  message: string;
};

/**
 * A production target.
 *
 * `compile` is generic in its payload on purpose: the entire reason this
 * interface exists is that two targets do not agree on what a payload looks
 * like, and flattening them into one shape would just re-establish LTX's
 * vocabulary as the neutral one.
 *
 * Both methods are pure. Neither uploads anything, resolves a provider, or
 * touches the network — a compiled payload is data, and who submits it is
 * M8's problem.
 */
export interface TimelineTarget<TPayload = unknown> {
  readonly id: string;
  readonly label: string;
  readonly constraints: TimelineConstraints;
  validate(timeline: Timeline): TimelineIssue[];
  compile(timeline: Timeline, options?: TimelineCompileOptions): TPayload;
}

export type TimelineCompileOptions = {
  /**
   * Which window of the timeline to emit, in frames. This is the chunking
   * primitive — a 3-minute film is 20–50 passes, and a target that generates
   * a window at a time needs to be told which one.
   */
  startFrame?: number;
  endFrame?: number;
};
