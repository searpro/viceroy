import type { Config } from "./config";

export type ResolutionPreset = { key: string; label: string; width: number; height: number };

/**
 * The aspect ratios a project can target (M7.1 PR-E).
 *
 * `config.sourceImage` used to carry two unrelated facts at once: the shape of
 * a frame (9:16) and how many pixels this machine can render in reasonable
 * time (432x768 ≈ 332k, measured at ~51s on CPU — finding F12). Those are
 * different kinds of thing. The pixel budget is a property of the hardware and
 * stays global; the shape belongs to the project, because a short movie is not
 * a vertical short.
 *
 * Deliberately a closed vocabulary rather than free-form width/height. Every
 * ratio here has to be representable on the multiple-of-16 grid
 * stable-diffusion.cpp silently rounds to (finding F4) at whatever budget is
 * configured, and `dimensionsForAspect` is what guarantees that — an arbitrary
 * ratio typed into a form has no such guarantee.
 */
export const ASPECT_RATIOS = [
  { key: "9:16", label: "Vertical (9:16)", ratio: 9 / 16 },
  { key: "4:5", label: "Portrait (4:5)", ratio: 4 / 5 },
  { key: "1:1", label: "Square (1:1)", ratio: 1 },
  { key: "16:9", label: "Landscape (16:9)", ratio: 16 / 9 },
  { key: "2.39:1", label: "Anamorphic (2.39:1)", ratio: 2.39 },
] as const;

export type AspectRatioKey = (typeof ASPECT_RATIOS)[number]["key"];
export const ASPECT_RATIO_KEYS = ASPECT_RATIOS.map((a) => a.key) as readonly AspectRatioKey[];

/** The default shape for a format: a movie is landscape, a short is vertical. */
export function defaultAspectFor(format: string): AspectRatioKey {
  return format === "short_video_narrative" ? "9:16" : "16:9";
}

export function aspectRatioValue(key: string | null | undefined, fallback: AspectRatioKey): number {
  const found = ASPECT_RATIOS.find((a) => a.key === (key ?? fallback));
  if (!found) throw new Error(`No such aspect ratio: ${key}`);
  return found.ratio;
}

/**
 * The best width/height for a ratio at a pixel budget, on a fixed grid.
 *
 * A search rather than `round(sqrt(budget * ratio))` because naive rounding is
 * not good enough at the edges: 2.39:1 rounds to 896x368, a 1.9% error, where
 * 880x368 is 0.05% off and costs 2% of the budget. Ratio fidelity is ranked
 * first and budget second precisely because of that trade — a frame at the
 * wrong shape gets letterboxed or cropped at render time, which is a visible
 * defect, while a frame 2% under budget is 2% faster.
 *
 * `multipleOf` is 16 for anything sent to stable-diffusion.cpp (F4: it rounds
 * a non-conforming dimension *up*, silently changing the ratio) and 2 for
 * encoder output.
 */
export function dimensionsForAspect(
  ratio: number,
  pixels: number,
  multipleOf: number,
): { width: number; height: number } {
  const idealWidth = Math.sqrt(pixels * ratio);
  let best: { width: number; height: number; ratioError: number; pixelError: number } | undefined;

  for (let steps = -6; steps <= 6; steps++) {
    const width = Math.max(multipleOf, (Math.round(idealWidth / multipleOf) + steps) * multipleOf);
    const height = Math.max(multipleOf, Math.round(width / ratio / multipleOf) * multipleOf);
    const ratioError = Math.abs(width / height / ratio - 1);
    const pixelError = Math.abs(width * height - pixels) / pixels;
    if (pixelError > 0.25) continue;
    if (
      !best ||
      ratioError < best.ratioError - 1e-9 ||
      (Math.abs(ratioError - best.ratioError) <= 1e-9 && pixelError < best.pixelError)
    ) {
      best = { width, height, ratioError, pixelError };
    }
  }
  if (!best) throw new Error(`No ${multipleOf}px-grid size fits ratio ${ratio} at ${pixels} pixels`);
  return { width: best.width, height: best.height };
}

/**
 * Scale factors of the configured base resolution, not fixed pixel counts.
 *
 * Scaling by area rather than by width keeps "HD" meaning the same amount of
 * work whatever shape the project is — 1080x1920 and 1920x1080 are the same
 * render cost, and a user picking "HD" for a landscape project should not
 * silently get four times the pixels of the vertical one.
 */
export const RESOLUTION_KEYS = ["standard", "hd", "high"] as const;

const SCALES: { key: (typeof RESOLUTION_KEYS)[number]; label: string; factor: number }[] = [
  { key: "standard", label: "Standard", factor: 2 / 3 },
  { key: "hd", label: "HD", factor: 1 },
  { key: "high", label: "High", factor: 4 / 3 },
];

/**
 * The presets, from a pixel budget rather than a `Config`.
 *
 * Split out so the new-project form can label its own options: the pixel
 * dimensions in a label depend on the shape the user has selected, which the
 * server does not know at render time. `lib/config.ts` is not safe in a client
 * bundle (zod, node:path), but this file only imports its *type*, so the form
 * can call this directly given the one number the server does pass down.
 */
export function resolutionPresetsFor(basePixels: number, aspect?: string | null): ResolutionPreset[] {
  const ratio = aspectRatioValue(aspect, "9:16");
  return SCALES.map(({ key, label, factor }) => {
    // `factor` scales the linear dimension, so area scales by its square —
    // preserved from the original definition so "Standard"/"HD"/"High" keep
    // producing the pixel counts they always did for a 9:16 project.
    const { width, height } = dimensionsForAspect(ratio, basePixels * factor * factor, 2);
    return { key, label: `${label} (${width}×${height})`, width, height };
  });
}

export function resolutionPresets(config: Config, aspect?: string | null): ResolutionPreset[] {
  return resolutionPresetsFor(config.video.width * config.video.height, aspect);
}

/** The preset a project resolves to, falling back to the base ("hd") preset. */
export function resolvePresetDimensions(
  config: Config,
  key: string | undefined,
  aspect?: string | null,
): { width: number; height: number } {
  const presets = resolutionPresets(config, aspect);
  const preset = presets.find((p) => p.key === (key ?? "hd"));
  if (!preset) throw new Error(`No such resolution preset: ${key}`);
  return { width: preset.width, height: preset.height };
}

/**
 * The size to generate a source frame at, for a project of this shape.
 *
 * Same pixel budget as `config.sourceImage` — that number is what the machine
 * can render in acceptable time and has nothing to do with the project's shape
 * — re-cut to the project's aspect on the multiple-of-16 grid. A 9:16 project
 * gets back exactly `config.sourceImage`, so nothing about the narrative
 * pipeline changes.
 *
 * Deriving both this and the output from one ratio is what replaces
 * `resolveConfig`'s old source-vs-video aspect guard: the two agree by
 * construction now, rather than by a check the user could fail at startup.
 */
export function sourceImageFor(config: Config, aspect?: string | null): { width: number; height: number } {
  const pixels = config.sourceImage.width * config.sourceImage.height;
  return dimensionsForAspect(aspectRatioValue(aspect, "9:16"), pixels, 16);
}
