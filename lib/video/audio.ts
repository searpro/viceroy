import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Fitting local audio into a form field.
 *
 * `POST /v1/videos` has no file-part field for audio: the only way in is
 * `audio_reference`, a *text* field holding a JSON-wrapped URL. Text parts are
 * capped at 1024 KB by the server's multipart parser, and base64 inflates
 * bytes by a third, so roughly 765 KB of audio is the ceiling — about 18
 * seconds of the 24 kHz PCM a WAV recording actually is. That is far too
 * little for narration, and it is the reason "Part exceeded maximum size of
 * 1024KB." shows up on a file that seems small.
 *
 * Re-encoding is what buys the room back, and it costs nothing the model uses:
 * Wan's audio conditioning runs on 16 kHz mono, so anything above that is
 * discarded on arrival regardless. 18 s of WAV at 854 KB becomes tens of KB as
 * mono MP3.
 */

/** Below this, bytes go inline untouched and ffmpeg is never invoked. */
export const INLINE_AUDIO_BUDGET_BYTES = 760_000;

const MIN_BITRATE = 24_000;
const MAX_BITRATE = 96_000;

/**
 * The highest standard bitrate whose encoding of `durationSeconds` still fits
 * the budget, or null if even the lowest will not fit.
 *
 * Quantised to 8 kbps steps because that is what MP3 encoders actually offer;
 * asking for an arbitrary rate gets silently rounded, which would put the
 * result back over budget.
 */
export function inlineAudioBitrate(durationSeconds: number, budgetBytes: number): number | null {
  if (!(durationSeconds > 0)) return MAX_BITRATE;
  const affordable = (budgetBytes * 8) / durationSeconds;
  const quantised = Math.floor(affordable / 8_000) * 8_000;
  if (quantised < MIN_BITRATE) return null;
  return Math.min(quantised, MAX_BITRATE);
}

/** Longest clip that can be inlined at all, for an error message worth reading. */
export function maxInlineAudioSeconds(budgetBytes: number): number {
  return Math.floor((budgetBytes * 8) / MIN_BITRATE);
}

export type InlineAudio = { bytes: Buffer; contentType: string; recoded: boolean };

/**
 * Shrink audio until it fits inline, or explain why it cannot.
 *
 * ffmpeg is only reached for when the bytes do not already fit, so a short
 * clip works on a machine that has never installed it.
 */
export async function inlineAudioReference(
  bytes: Buffer,
  contentType: string,
  budgetBytes = INLINE_AUDIO_BUDGET_BYTES,
): Promise<InlineAudio> {
  if (bytes.length <= budgetBytes) return { bytes, contentType, recoded: false };

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "viceroy-video-audio-"));
  const source = path.join(dir, "source");
  const encoded = path.join(dir, "encoded.mp3");
  try {
    await fs.writeFile(source, bytes);
    const duration = await probeDurationSeconds(source);
    const bitrate = inlineAudioBitrate(duration, budgetBytes);
    if (bitrate === null) {
      throw new Error(
        `This audio is ${Math.round(duration)}s. The video server accepts inline audio only as a ` +
          `form field capped at 1 MB, which is about ${maxInlineAudioSeconds(budgetBytes)}s once ` +
          `encoded. Shorten it, or host it at a URL the video server can reach and paste that instead.`,
      );
    }

    // Mono 16 kHz is what the model's audio encoder consumes; downmixing here
    // rather than sending stereo 48 kHz is free quality-wise and is most of
    // the saving.
    await run("ffmpeg", [
      "-v", "error",
      "-i", source,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", String(bitrate),
      "-y", encoded,
    ]);

    const out = await fs.readFile(encoded);
    if (out.length > budgetBytes) {
      throw new Error(
        `This audio is still ${Math.round(out.length / 1024)} KB after re-encoding, over the video ` +
          `server's 1 MB field limit. Shorten it, or host it at a URL the server can reach.`,
      );
    }
    return { bytes: out, contentType: "audio/mpeg", recoded: true };
  } catch (error) {
    if (isMissingBinary(error)) {
      throw new Error(
        `This audio is ${Math.round(bytes.length / 1024)} KB, over the video server's 1 MB limit for ` +
          `an inline reference, and ffmpeg is not installed to re-encode it. Install ffmpeg, shorten ` +
          `the clip, or host it at a URL the video server can reach.`,
      );
    }
    throw error;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function probeDurationSeconds(file: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

function isMissingBinary(error: unknown): boolean {
  return (error as { code?: string })?.code === "ENOENT";
}
