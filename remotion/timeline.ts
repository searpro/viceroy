/**
 * When each shot is on screen, and how strongly.
 *
 * Kept out of the component so it can be tested directly: crossfade maths is
 * exactly where an off-by-one hides, and the symptom — a black frame between
 * two shots, or a caption over the wrong image — is expensive to spot by
 * watching a three-minute render.
 */

export type TimelineShot = { src: string; startMs: number; endMs: number };
export type TimelineCue = { text: string; startMs: number; endMs: number };

export type VisibleShot = {
  shot: TimelineShot;
  /** 0–1; shots overlap during a crossfade. */
  opacity: number;
  /** 0–1 through this shot's own window, driving the slow zoom. */
  progress: number;
};

function ramp(value: number, from: number, to: number): number {
  if (from === to) return value >= to ? 1 : 0;
  return Math.max(0, Math.min(1, (value - from) / (to - from)));
}

/**
 * How long this shot takes to fade in, given how long it is on screen.
 *
 * A fixed 500ms crossfade was fine when a picture held for fifteen seconds. M9
 * cuts every 1.5-3.5s, and half a second of dissolve on a 1.5-second shot is a
 * third of it spent half-transparent — the sequence reads as mush rather than
 * as cuts. Capping the fade at a fifth of the shot keeps a short shot crisp
 * and leaves a long one exactly as it was.
 */
export function crossfadeFor(shot: TimelineShot, crossfadeMs: number): number {
  return Math.min(crossfadeMs, Math.max(0, (shot.endMs - shot.startMs) * 0.2));
}

export function visibleShotsAt(
  nowMs: number,
  shots: TimelineShot[],
  crossfadeMs: number,
): VisibleShot[] {
  return shots
    .map((shot, index) => {
      const fade = crossfadeFor(shot, crossfadeMs);
      const fadeIn = ramp(nowMs, shot.startMs - fade, shot.startMs);
      // The last shot holds to the end rather than fading out, so the video
      // never finishes on black while narration is still playing.
      const isLast = index === shots.length - 1;
      const fadeOut = isLast ? 1 : 1 - ramp(nowMs, shot.endMs, shot.endMs + fade);

      return {
        shot,
        opacity: Math.min(fadeIn, fadeOut),
        progress: ramp(nowMs, shot.startMs, shot.endMs),
      };
    })
    .filter((entry) => entry.opacity > 0);
}

export function activeCueAt(nowMs: number, cues: TimelineCue[]): TimelineCue | undefined {
  return cues.find((cue) => nowMs >= cue.startMs && nowMs < cue.endMs);
}

/** Frames needed to cover the narration without truncating its final word. */
export function durationInFrames(durationMs: number, fps: number): number {
  return Math.max(1, Math.ceil((durationMs / 1000) * fps));
}
