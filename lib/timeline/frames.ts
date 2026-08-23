/**
 * Turning a duration in milliseconds into a frame count a model will accept.
 *
 * Video models quantise: LTX refuses anything but `n % 8 == 1` frames (…, 97,
 * 105, 113, 121). That rule is a property of the *target*, not of the
 * timeline, which is why the quantum is passed in rather than hard-coded —
 * see `TimelineConstraints.frameQuantum` in types.ts.
 *
 * Its own module, and deliberately dependency-free, because M8 needs exactly
 * this arithmetic for `shots.frames` and should import it rather than write a
 * second version that rounds the other way at the midpoint.
 */

/** `n % modulus === remainder`. LTX 2.x is `{ modulus: 8, remainder: 1 }`. */
export type FrameQuantum = { modulus: number; remainder: number };

/** The unquantised frame count a duration is worth at this frame rate. */
export function framesForMs(durationMs: number, fps: number): number {
  if (!Number.isFinite(durationMs) || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Cannot convert ${durationMs}ms at ${fps}fps to frames`);
  }
  return Math.round((durationMs / 1000) * fps);
}

/** What a frame count is worth back in milliseconds — the exact inverse. */
export function msForFrames(frames: number, fps: number): number {
  if (!Number.isFinite(frames) || !Number.isFinite(fps) || fps <= 0) {
    throw new Error(`Cannot convert ${frames} frames at ${fps}fps to milliseconds`);
  }
  return Math.round((frames / fps) * 1000);
}

/**
 * The nearest conforming frame count, never below the smallest one that exists.
 *
 * Ties round *up*. A clip a frame longer than its span is trimmed at assembly
 * time; one a frame shorter has to hold its last frame, which reads as a
 * stutter. Given a choice, overshoot.
 */
export function quantiseFrames(frames: number, quantum: FrameQuantum | null): number {
  if (!quantum) return Math.max(1, Math.round(frames));
  const { modulus, remainder } = quantum;
  if (modulus <= 0) throw new Error(`Frame quantum modulus must be positive, got ${modulus}`);

  // The conforming values are `remainder + k * modulus` for whole k >= 0; the
  // smallest usable one is the first of those that is at least one frame.
  const smallest = remainder >= 1 ? remainder : remainder + Math.ceil((1 - remainder) / modulus) * modulus;
  if (frames <= smallest) return smallest;

  const k = (frames - remainder) / modulus;
  const low = remainder + Math.floor(k) * modulus;
  const high = low + modulus;
  return frames - low < high - frames ? Math.max(smallest, low) : high;
}

/** `quantiseFrames(framesForMs(...))`, the pairing every caller actually wants. */
export function quantisedFramesForMs(
  durationMs: number,
  fps: number,
  quantum: FrameQuantum | null,
): number {
  return quantiseFrames(framesForMs(durationMs, fps), quantum);
}
