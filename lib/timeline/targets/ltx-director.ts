/**
 * The LTX Director target.
 *
 * Director is marketed as a mouse-driven timeline editor, but every one of its
 * inputs is an ordinary ComfyUI widget, so the node is drivable headlessly —
 * that reading is what the LTX Long-Video Feasibility page's "read as an API
 * rather than a UI" section establishes, and it is what makes this file a
 * compiler rather than a request to a human.
 *
 * <caution>
 * The `timeline_data` shape below is **reverse-engineered from a desk read of
 * `ltx_director.py` v2.0.4, not verified against a running node.** The node
 * documents the field as "auto-managed; do not edit by hand", meaning its
 * schema is whatever the JavaScript editor last emitted and carries no
 * compatibility contract at all. The fixture test next to this file pins
 * *our* output so a change here is visible in a diff; it does not and cannot
 * prove Director accepts it. That proof is M8 PR0's spike (unknown U1), and
 * nothing in M7.2 submits this payload anywhere.
 * </caution>
 */

import { quantisedFramesForMs } from "../frames";
import { estimateSpeechMs, renderDialogueLine, speakerCount } from "../speech";
import type { TimelineSegment } from "../types";
import type {
  Timeline,
  TimelineCompileOptions,
  TimelineConstraints,
  TimelineIssue,
  TimelineTarget,
} from "../types";

export const LTX_DIRECTOR_TARGET_ID = "ltx-director";

/**
 * One entry in `timeline_data.segments` — a keyframe pinned at a frame
 * position, not a span. Spans are `motionSegments`, below.
 */
export type LtxTimelineImageSegment = {
  type: "image";
  imageFile: string;
  start: number;
  length: number;
  trimStart: number;
  isEndFrame: boolean;
};

/** One Prompt Relay span: a prompt that applies across a window of frames. */
export type LtxMotionSegment = {
  start: number;
  length: number;
  prompt: string;
};

export type LtxTimelineData = {
  global_prompt: string;
  segments: LtxTimelineImageSegment[];
  motionSegments: LtxMotionSegment[];
  audioSegments: { start: number; length: number; audioFile: string }[];
  retakeMode: boolean;
};

export type LtxDirectorPayload = {
  global_prompt: string;
  /** One beat per segment, `|`-separated, in timeline order. */
  local_prompts: string;
  /** Quantised frame counts, comma-separated, in timeline order. */
  segment_lengths: string;
  /** One float per keyframe, in `timeline_data.segments` order. */
  guide_strength: string;
  /** The JSON string the node's own widget would otherwise hold. */
  timeline_data: string;
  start_frame: number;
  end_frame: number;
  use_custom_audio: boolean;
  inpaint_audio: boolean;
  /**
   * Not a Director input. The manifest of which asset has to be uploaded to
   * ComfyUI's input directory under which name before this payload means
   * anything — `imageFile` above is a filename, and something has to put a
   * file there. Emitted as data so the submit step (M8) does not have to
   * re-derive the naming scheme and get it subtly different.
   */
  images: { fileName: string; assetId: string }[];
};

/**
 * `~20s` is the published single-pass ceiling for the hosted tier; locally,
 * VRAM binds well before that. Treated as a hard error rather than a warning
 * because a segment past it does not degrade, it fails to sample.
 */
const MAX_SEGMENT_MS = 20_000;

/** Below this a quantised clip is a handful of frames and reads as a glitch. */
const SHORT_SEGMENT_MS = 1_000;

const constraints: TimelineConstraints = {
  // 24/25/50 are the rates LTX 2.x is attested to emit. 30 is deliberately
  // absent: the narrative pipeline's own compositions are 30fps, so a
  // timeline that inherited that number should be flagged rather than
  // silently resampled into judder on every shot (M8 detail's render section).
  fpsChoices: [24, 25, 50],
  frameQuantum: { modulus: 8, remainder: 1 },
  dimensionMultiple: 32,
  maxSegmentMs: MAX_SEGMENT_MS,
  // Chunking via `start_frame`/`end_frame` is what makes total length
  // unbounded in principle — a 3–5 minute film is 20–50 passes over one
  // timeline, not one pass.
  maxTotalMs: null,
  maxSegments: null,
  supportsEndKeyframe: true,
  supportsGlobalPrompt: true,
  supportsCustomAudio: true,
};

/**
 * One segment's video prompt, in the shape LTX documents.
 *
 * LTX takes prose — no tags, no weighting brackets, no quality-tag tail — and
 * its guide asks for a single flowing paragraph covering six elements in
 * order: shot, scene, action, characters, camera, then **audio**. Audio is
 * not an afterthought there: the model generates sound and picture in one
 * pass, and it takes its direction for both from this one string.
 *
 * Scene, characters and lighting are deliberately thin here, because the
 * start keyframe already carries them — this is image-to-video, so the frame
 * is the description. What the text has to supply is what the still cannot:
 * what changes, and what it sounds like.
 *
 * `previous` is used only to state audio continuity across the cut, which
 * LTX's multishot guidance explicitly asks for ("the piano score continues
 * across the cut", "the dialogue drops; only wind remains"). Deriving it
 * beats asking a human to write it once per segment, and Director's Prompt
 * Relay gives exactly one prompt per span to put it in.
 */
export function composeSegmentPrompt(
  segment: TimelineSegment,
  previous?: TimelineSegment,
): string {
  const parts: string[] = [];

  // 1-2. Shot, in real cinematography terms.
  parts.push(
    `${sentenceCase(segment.camera.shotType)} shot, ${segment.camera.angle} angle, ` +
      `${segment.camera.lens} lens.`,
  );

  // 3-5. Action and camera. `videoPrompt` is the motion register and already
  // describes both; it is the human-editable half and goes in as written,
  // only sentence-cased so it reads as prose next to the clause before it.
  const action = segment.videoPrompt.trim();
  if (action) parts.push(sentence(action));

  // 6. Audio, last, in the order the guide lists: bed, then events, then
  // score, then speech.
  const audio: string[] = [];
  if (segment.ambience.trim()) audio.push(sentence(segment.ambience));
  if (segment.foley.trim()) audio.push(sentence(segment.foley));
  if (segment.music.trim()) audio.push(sentence(segment.music));
  for (const line of segment.dialogue) audio.push(sentence(renderDialogueLine(line)));

  const continuity = audioContinuity(segment, previous);
  if (continuity) audio.push(continuity);

  parts.push(...audio);
  return parts.join(" ");
}

/**
 * The "state what carries across the cut" clause LTX's multishot guidance asks
 * for.
 *
 * Only ever describes a *change* or a deliberate carry — a segment that sounds
 * like the one before it with nothing to say produces no clause, because
 * padding every prompt with a sentence the model can ignore dilutes the ones
 * that matter.
 */
function audioContinuity(segment: TimelineSegment, previous?: TimelineSegment): string {
  if (!previous) return "";
  const clauses: string[] = [];

  const music = segment.music.trim();
  const previousMusic = previous.music.trim();
  if (music && music === previousMusic) clauses.push("the score continues across the cut");
  else if (!music && previousMusic) clauses.push("the music drops");

  // Deliberately does not echo the ambience string — repeating "steady sea
  // ambience, rigging knocking against masts" a second time in the same
  // paragraph reads as a second, different sound, not as the same one
  // continuing.
  const ambience = segment.ambience.trim();
  if (ambience && ambience === previous.ambience.trim()) clauses.push("the ambience continues");

  if (segment.dialogue.length === 0 && previous.dialogue.length > 0) {
    clauses.push("the dialogue drops");
  }

  if (clauses.length === 0) return "";
  return sentence(clauses.join("; "));
}

/**
 * One sentence: capitalised, and terminated exactly once.
 *
 * The trailing-quote case is the reason this is not a one-liner. A spoken
 * line ends `stairs."` — already punctuated, inside the quotation marks — and
 * naively appending a stop produced `stairs.".`, which is the kind of detail
 * that survives into a generated performance.
 */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const capitalised = sentenceCase(trimmed);
  const withoutTrailingQuote = capitalised.replace(/["']$/, "");
  return /[.!?]$/.test(withoutTrailingQuote) ? capitalised : `${capitalised}.`;
}

function sentenceCase(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

function imageFileName(assetId: string): string {
  // Keyed on the asset, not the segment position, so reordering a timeline
  // does not rename an already-uploaded file. `.png` because every image this
  // codebase generates is stored as one (`storeAsset`, mimeType "image/png").
  return `viceroy-${assetId}.png`;
}

/** Per-segment quantised frame counts and their prefix-summed frame offsets. */
function frameLayout(timeline: Timeline): { frames: number; startFrame: number }[] {
  let offset = 0;
  return timeline.segments.map((segment) => {
    const frames = quantisedFramesForMs(segment.durationMs, timeline.fps, constraints.frameQuantum);
    const startFrame = offset;
    offset += frames;
    return { frames, startFrame };
  });
}

function validate(timeline: Timeline): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  const whole = (severity: TimelineIssue["severity"], message: string) =>
    issues.push({ severity, segmentIndex: null, message });

  if (timeline.segments.length === 0) {
    whole("error", "The timeline has no segments — nothing would be generated.");
  }

  if (!constraints.fpsChoices.includes(timeline.fps)) {
    whole(
      "error",
      `LTX emits ${constraints.fpsChoices.join("/")}fps; ${timeline.fps}fps would be resampled, ` +
        `which shows up as judder on every shot.`,
    );
  }

  for (const [name, value] of [
    ["Width", timeline.width],
    ["Height", timeline.height],
  ] as const) {
    if (value % constraints.dimensionMultiple !== 0) {
      whole(
        "error",
        `${name} ${value} is not a multiple of ${constraints.dimensionMultiple} — LTX refuses it. ` +
          `The nearest usable value is ${Math.round(value / constraints.dimensionMultiple) * constraints.dimensionMultiple}.`,
      );
    }
  }

  if (!timeline.globalPrompt.trim()) {
    whole("warning", "No global prompt — style and character anchoring rest entirely on the keyframes.");
  }

  // 24 and 25 are the rates LTX's own guidance recommends for performance;
  // 50 pulls a delivered line toward a video look rather than a filmed one.
  if (timeline.fps === 50 && timeline.segments.some((segment) => segment.dialogue.length > 0)) {
    whole(
      "warning",
      "This timeline has spoken dialogue at 50fps; 24 or 25 reads as performance rather than video.",
    );
  }

  timeline.segments.forEach((segment, index) => {
    const at = (severity: TimelineIssue["severity"], message: string) =>
      issues.push({ severity, segmentIndex: index, message });

    if (segment.durationMs > constraints.maxSegmentMs) {
      at(
        "error",
        `${(segment.durationMs / 1000).toFixed(1)}s exceeds LTX's ~${MAX_SEGMENT_MS / 1000}s single-pass ceiling.`,
      );
    } else if (segment.durationMs < SHORT_SEGMENT_MS) {
      at(
        "warning",
        `${(segment.durationMs / 1000).toFixed(1)}s is only ` +
          `${quantisedFramesForMs(segment.durationMs, timeline.fps, constraints.frameQuantum)} frames.`,
      );
    }

    if (!segment.startKeyframeAssetId) {
      at("error", "No start keyframe — the segment has nothing to condition on.");
    }
    if (!segment.videoPrompt.trim() && segment.dialogue.length === 0) {
      at("warning", "No video prompt and no dialogue — Prompt Relay gets nothing for this span.");
    }

    // The constraint native audio introduces: a shot's length stops being a
    // free choice once the model has to fit words into it. LTX's own guidance
    // is to keep a line short enough for the clip; overrun means the end of
    // the line is simply not there.
    const speechMs = estimateSpeechMs(segment.dialogue);
    if (speechMs > segment.durationMs) {
      at(
        "error",
        `${segment.dialogue.reduce((n, d) => n + d.line.trim().split(/\s+/).length, 0)} words of ` +
          `dialogue need about ${(speechMs / 1000).toFixed(1)}s, but this segment is ` +
          `${(segment.durationMs / 1000).toFixed(1)}s — the line would be cut off.`,
      );
    }

    if (speakerCount(segment.dialogue) > 1) {
      at(
        "warning",
        `${speakerCount(segment.dialogue)} speakers in one clip — LTX lip-syncs one speaker per ` +
          `shot most cleanly. Consider splitting the shot.`,
      );
    }

    for (const line of segment.dialogue) {
      if (!line.delivery.trim()) {
        at(
          "warning",
          `${line.characterName} has no locked voice, so their delivery is unconditioned and may ` +
            `differ between shots. Redo casting to lock it.`,
        );
        break;
      }
    }
    if (segment.guideStrength < 0 || segment.guideStrength > 1) {
      at("error", `Guide strength ${segment.guideStrength} is outside 0–1.`);
    }
  });

  return issues;
}

function compile(timeline: Timeline, options: TimelineCompileOptions = {}): LtxDirectorPayload {
  const layout = frameLayout(timeline);
  const totalFrames = layout.reduce((sum, entry) => sum + entry.frames, 0);
  // Composed once and reused for both `local_prompts` and `motionSegments`:
  // Prompt Relay reads one of them and the widget holds the other, and two
  // different strings describing the same span is a bug waiting for whichever
  // one the node happens to prefer.
  const composed = timeline.segments.map((segment, index) =>
    composeSegmentPrompt(segment, index > 0 ? timeline.segments[index - 1] : undefined),
  );

  const images: LtxTimelineImageSegment[] = [];
  const manifest = new Map<string, string>();
  const guideStrengths: number[] = [];

  timeline.segments.forEach((segment, index) => {
    const { frames, startFrame } = layout[index]!;

    const push = (assetId: string, atFrame: number, isEndFrame: boolean) => {
      const fileName = imageFileName(assetId);
      manifest.set(fileName, assetId);
      images.push({ type: "image", imageFile: fileName, start: atFrame, length: 1, trimStart: 0, isEndFrame });
      guideStrengths.push(segment.guideStrength);
    };

    if (segment.startKeyframeAssetId) push(segment.startKeyframeAssetId, startFrame, false);
    // `frames - 1`: the last frame *of this segment*, not the first of the
    // next one, which is a different picture.
    if (segment.endKeyframeAssetId) push(segment.endKeyframeAssetId, startFrame + frames - 1, true);
  });

  const timelineData: LtxTimelineData = {
    global_prompt: timeline.globalPrompt,
    segments: images,
    motionSegments: timeline.segments.map((_segment, index) => ({
      start: layout[index]!.startFrame,
      length: layout[index]!.frames,
      prompt: composed[index]!,
    })),
    // Empty until the Development chain has narration of its own. When it
    // does, this is where it goes — `use_custom_audio` below is already the
    // switch, per the feasibility page's "our TTS narration goes in as the
    // custom audio track" design.
    audioSegments: timeline.audio
      ? [{ start: 0, length: totalFrames, audioFile: `viceroy-${timeline.audio.assetId}.wav` }]
      : [],
    retakeMode: false,
  };

  return {
    global_prompt: timeline.globalPrompt,
    local_prompts: composed.join("|"),
    segment_lengths: layout.map((entry) => entry.frames).join(","),
    guide_strength: guideStrengths.join(","),
    // Stringified rather than nested: the node's input is a STRING widget, and
    // a JSON object placed there would be coerced by whatever happens to
    // stringify it first.
    timeline_data: JSON.stringify(timelineData),
    start_frame: options.startFrame ?? 0,
    end_frame: options.endFrame ?? totalFrames,
    use_custom_audio: timeline.audio !== null,
    inpaint_audio: timeline.audio !== null,
    images: [...manifest].map(([fileName, assetId]) => ({ fileName, assetId })),
  };
}

export const ltxDirectorTarget: TimelineTarget<LtxDirectorPayload> = {
  id: LTX_DIRECTOR_TARGET_ID,
  label: "LTX Director (LTX 2.3)",
  constraints,
  validate,
  compile,
};

/** Exported for the UI's total-length readout, which needs the quantised truth. */
export function ltxFrameLayout(timeline: Timeline): { frames: number; startFrame: number }[] {
  return frameLayout(timeline);
}

/** The last frame of the timeline, after quantisation. Not `totalDurationMs × fps`. */
export function ltxTotalFrames(timeline: Timeline): number {
  return frameLayout(timeline).reduce((sum, entry) => sum + entry.frames, 0);
}
