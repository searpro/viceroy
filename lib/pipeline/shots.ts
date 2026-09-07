/**
 * How many pictures cover a scene, and which words each one covers.
 *
 * A scene is a span of narration, not a picture. Until M9 it held exactly one
 * still for its whole span — routinely fifteen to twenty-five seconds of a
 * frame with nothing moving but the Ken Burns drift, which is well past the
 * point a short-form viewer stops watching.
 *
 * Everything here is deliberately pure and deliberately about *counts and
 * ranges*, never about milliseconds on the finished timeline. Image generation
 * runs long before there is any audio to measure, so the narration length used
 * here is an estimate — and an estimate is allowed to decide how many shots
 * exist, but must never decide when one of them appears. That comes from the
 * aligned words each shot covers, once `runSubtitleAlign` has real timings.
 *
 * Getting that distinction wrong is how the previous product shipped desynced
 * subtitles twice (findings F1 and F5).
 */

import type { ShotType } from "../db/schema";
import { splitWords } from "./align";
import { splitSentences } from "./segment";

/**
 * Speech rate used to guess how long a scene will take to narrate.
 *
 * An estimate, not a measurement — the same 150 wpm figure M7.2 uses, and
 * flagged there as unmeasured. It is safe to be wrong here in a way it is not
 * elsewhere: being ten percent out changes a scene from five shots to six,
 * where being ten percent out on a caption's position is a visible defect.
 */
export const NARRATION_WPM = 150;

/** The pacing window a narrative style asks for, in milliseconds. */
export type ShotPacing = { targetMs: number; minMs: number; maxMs: number };

export type WordRange = {
  /** Inclusive, and relative to the scene's own narration — not the project's. */
  startWord: number;
  endWord: number;
};

export function estimateNarrationMs(words: number, wpm: number = NARRATION_WPM): number {
  if (words <= 0) return 0;
  return Math.round((words / wpm) * 60_000);
}

/**
 * How many shots a scene's narration should be covered by.
 *
 * The target sets the ambition and the floor/ceiling are hard: a count is only
 * accepted if it leaves every shot's *mean* duration inside the window. So a
 * scene estimated at 9s against a 2.5s target asks for 4 shots (2.25s each)
 * rather than the 3 (3s each) plain rounding would give, and a scene estimated
 * at 4s takes 2 rather than sitting one long shot above the ceiling.
 *
 * Capped at one shot per word, which only bites on absurd pacing settings but
 * is the guarantee that `partitionWords` is never asked for an empty range.
 */
export function planShotCount(
  words: number,
  pacing: ShotPacing,
  wpm: number = NARRATION_WPM,
): number {
  if (words <= 0) return 0;

  const estimatedMs = estimateNarrationMs(words, wpm);
  const maxMs = Math.max(pacing.maxMs, pacing.minMs);
  if (estimatedMs <= maxMs) return 1;

  // Any fewer than `fewest` and some shot must exceed the ceiling; any more
  // than `most` and some shot must fall under the floor. The ceiling wins a
  // disagreement — holding a picture too long is the defect being fixed.
  const fewest = Math.ceil(estimatedMs / maxMs);
  const most = Math.max(fewest, Math.floor(estimatedMs / Math.max(pacing.minMs, 1)));
  const byTarget = Math.round(estimatedMs / Math.max(pacing.targetMs, 1));

  return Math.max(1, Math.min(Math.min(Math.max(byTarget, fewest), most), words));
}

/**
 * Where each sentence of a scene's narration begins, counted in words.
 *
 * `splitSentences` normalises whitespace and slices, so the sentences it
 * returns re-tile the same word sequence `splitWords` sees. If that ever stops
 * being true these offsets simply become less attractive cut points — they are
 * only ever *preferences*, and every cut is clamped into range regardless.
 */
function sentenceStartWords(script: string): number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const sentence of splitSentences(script)) {
    starts.push(cursor);
    cursor += splitWords(sentence).length;
  }
  return starts;
}

/**
 * Split a scene's narration into `count` contiguous word ranges.
 *
 * Cuts land on an even division of the scene and are then pulled onto a
 * sentence boundary where one is close enough, because a picture that changes
 * mid-clause reads as a mistake while one that changes between sentences reads
 * as an edit. The pull is a preference, never a requirement: a scene of one
 * long sentence still gets cut evenly rather than refusing to be covered.
 *
 * The ranges tile the scene exactly — no gaps, no overlaps, none empty — for
 * the same reason `normaliseSpans` guarantees it of scenes. A gap here would
 * be a stretch of narration with no picture behind it.
 */
export function partitionWords(script: string, count: number): WordRange[] {
  const total = splitWords(script).length;
  if (total === 0) return [];

  const shots = Math.max(1, Math.min(Math.trunc(count), total));
  if (shots === 1) return [{ startWord: 0, endWord: total - 1 }];

  const boundaries = sentenceStartWords(script);
  // Wide enough to reach the nearest sentence in ordinary narration, narrow
  // enough that snapping cannot collapse a shot to a fraction of its share.
  const tolerance = Math.max(2, Math.round(total / (shots * 2)));

  const cuts: number[] = [];
  for (let i = 1; i < shots; i++) {
    const ideal = Math.round((i * total) / shots);
    // Leave one word for every shot on each side of this cut, so the tiling
    // stays non-empty however the boundaries fall.
    const lowest = Math.max(i, (cuts[cuts.length - 1] ?? 0) + 1);
    const highest = total - (shots - i);

    let cut = Math.min(Math.max(ideal, lowest), highest);
    let nearest = Infinity;
    for (const boundary of boundaries) {
      if (boundary < lowest || boundary > highest) continue;
      const distance = Math.abs(boundary - ideal);
      if (distance <= tolerance && distance < nearest) {
        nearest = distance;
        cut = boundary;
      }
    }
    cuts.push(cut);
  }

  const edges = [0, ...cuts, total];
  return edges.slice(0, -1).map((start, i) => ({ startWord: start, endWord: edges[i + 1]! - 1 }));
}

/**
 * The coverage a scene's shots are assigned, in order.
 *
 * Assigned by the pipeline rather than chosen by the model, for the reason
 * M7.1 PR-A2 learned about references: a model asked to "vary the framing"
 * across separate calls does not, because each call cannot see the others.
 * Handing shot N its type up front makes variety structural.
 *
 * The opening shot establishes; the rest alternate between shots that carry a
 * face and shots that do not. That is ordinary coverage — a scene is not five
 * versions of the same framing — and it is also what keeps the bill down: a
 * frame with no character in it needs no reference portrait, so it costs about
 * 51s instead of about 142s (findings F12, F30).
 */
const COVERAGE_CYCLE: ShotType[] = ["medium", "insert", "close_up", "wide", "detail", "over_shoulder"];

export function assignShotTypes(count: number): ShotType[] {
  if (count <= 0) return [];
  if (count === 1) return ["medium"];
  return ["establishing", ...Array.from({ length: count - 1 }, (_, i) => COVERAGE_CYCLE[i % COVERAGE_CYCLE.length]!)];
}
