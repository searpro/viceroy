import path from "node:path";
import { z } from "zod";

// stable-diffusion.cpp rounds a non-conforming dimension UP to the next
// multiple of 16 instead of refusing it, so 360 silently becomes 368 and the
// frame is no longer 9:16. Rejecting here is the only way the caller ever
// learns. See docs/findings.md F4.
const multipleOf16 = z
  .number()
  .int()
  .positive()
  .refine((n) => n % 16 === 0, {
    message: "must be a multiple of 16 — stable-diffusion.cpp silently rounds up, breaking the aspect ratio",
  });

const envSchema = z.object({
  VICEROY_DATA_DIR: z.string().default("./data"),
  SD_API_URL: z.url().default("http://localhost:3004"),

  // Video generation is the one kind that does not come from sd-api: it is
  // served by ComfyUI, whose default port is 8188. Only used to seed the video
  // provider's base URL on a fresh install — after that the row in the
  // Providers screen is what stages read.
  COMFY_API_URL: z.url().default("http://localhost:8188"),

  // Deliberately an env var and not a provider column. It is an account-wide
  // credential that can start and stop machines that cost money — a different
  // class of secret from a per-provider key, and one that has no business
  // being editable from a web form or readable out of the database file.
  // Absent means the RunPod controls are simply not offered.
  RUNPOD_API_KEY: z.string().trim().min(1).optional(),

  // How large a frame this machine can produce is a property of the machine:
  // 1080x1920 is routine on a GPU and fails outright on a CPU-only box.
  SOURCE_IMAGE_WIDTH: z.coerce.number().pipe(multipleOf16).default(432),
  SOURCE_IMAGE_HEIGHT: z.coerce.number().pipe(multipleOf16).default(768),

  VIDEO_WIDTH: z.coerce.number().int().positive().default(1080),
  VIDEO_HEIGHT: z.coerce.number().int().positive().default(1920),

  QC_MAX_ITERATIONS: z.coerce.number().int().min(1).default(3),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),

  // Must comfortably exceed the slowest single inference. A one-shot
  // narration of a full story runs ~6 minutes (F18), and Node's own default
  // of 5 minutes is below that — see F19.
  SD_API_TIMEOUT_MS: z.coerce.number().int().min(60_000).default(30 * 60_000),
});

export type Config = {
  dataDir: string;
  databasePath: string;
  outputsDir: string;
  cacheDir: string;
  sdApiUrl: string;
  comfyApiUrl: string;
  runpodApiKey: string | undefined;
  sourceImage: { width: number; height: number };
  video: { width: number; height: number };
  qcMaxIterations: number;
  jobMaxAttempts: number;
  sdApiTimeoutMs: number;
};

export function resolveConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.parse(env);
  const dataDir = path.resolve(parsed.VICEROY_DATA_DIR);

  const source = { width: parsed.SOURCE_IMAGE_WIDTH, height: parsed.SOURCE_IMAGE_HEIGHT };
  const sourceRatio = source.width / source.height;
  const videoRatio = parsed.VIDEO_WIDTH / parsed.VIDEO_HEIGHT;
  // A source frame at a different aspect ratio than the output can only be
  // letterboxed or cropped, and both are silent quality losses discovered at
  // render time rather than at configuration time.
  if (Math.abs(sourceRatio - videoRatio) > 0.001) {
    throw new Error(
      `Source image ${source.width}x${source.height} (${sourceRatio.toFixed(4)}) does not match ` +
        `video ${parsed.VIDEO_WIDTH}x${parsed.VIDEO_HEIGHT} (${videoRatio.toFixed(4)}). ` +
        `Source frames are upscaled, never reframed.`,
    );
  }

  return {
    dataDir,
    databasePath: path.join(dataDir, "viceroy.db"),
    outputsDir: path.join(dataDir, "outputs"),
    cacheDir: path.join(dataDir, "cache"),
    sdApiUrl: parsed.SD_API_URL.replace(/\/$/, ""),
    comfyApiUrl: parsed.COMFY_API_URL.replace(/\/$/, ""),
    runpodApiKey: parsed.RUNPOD_API_KEY,
    sourceImage: source,
    video: { width: parsed.VIDEO_WIDTH, height: parsed.VIDEO_HEIGHT },
    qcMaxIterations: parsed.QC_MAX_ITERATIONS,
    jobMaxAttempts: parsed.JOB_MAX_ATTEMPTS,
    sdApiTimeoutMs: parsed.SD_API_TIMEOUT_MS,
  };
}
