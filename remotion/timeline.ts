/**
 * When each scene is on screen, and how strongly.
 *
 * Kept out of the component so it can be tested directly: crossfade maths is
 * exactly where an off-by-one hides, and the symptom — a black frame between
 * two scenes, or a caption over the wrong image — is expensive to spot by
 * watching a three-minute render.
 */

export type TimelineScene = { src: string; startMs: number; endMs: number };
export type TimelineCue = { text: string; startMs: number; endMs: number };

export type VisibleScene = {
  scene: TimelineScene;
  /** 0–1; scenes overlap during a crossfade. */
  opacity: number;
  /** 0–1 through this scene's own window, driving the slow zoom. */
  progress: number;
};

function ramp(value: number, from: number, to: number): number {
  if (from === to) return value >= to ? 1 : 0;
  return Math.max(0, Math.min(1, (value - from) / (to - from)));
}

export function visibleScenesAt(
  nowMs: number,
  scenes: TimelineScene[],
  crossfadeMs: number,
): VisibleScene[] {
  return scenes
    .map((scene, index) => {
      const fadeIn = ramp(nowMs, scene.startMs - crossfadeMs, scene.startMs);
      // The last scene holds to the end rather than fading out, so the video
      // never finishes on black while narration is still playing.
      const isLast = index === scenes.length - 1;
      const fadeOut = isLast ? 1 : 1 - ramp(nowMs, scene.endMs, scene.endMs + crossfadeMs);

      return {
        scene,
        opacity: Math.min(fadeIn, fadeOut),
        progress: ramp(nowMs, scene.startMs, scene.endMs),
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
