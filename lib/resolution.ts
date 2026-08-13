import type { Config } from "./config";

export type ResolutionPreset = { key: string; label: string; width: number; height: number };

/**
 * Scale factors of the configured base resolution, not fixed pixel counts.
 *
 * `resolveConfig` already enforces that `config.video`'s aspect ratio equals
 * the source image's, so scaling both dimensions by the same factor and
 * rounding to the nearest even number (what an h264 encoder wants) keeps
 * every preset at that exact ratio without re-deriving it here.
 */
export const RESOLUTION_KEYS = ["standard", "hd", "high"] as const;

const SCALES: { key: (typeof RESOLUTION_KEYS)[number]; label: string; factor: number }[] = [
  { key: "standard", label: "Standard", factor: 2 / 3 },
  { key: "hd", label: "HD", factor: 1 },
  { key: "high", label: "High", factor: 4 / 3 },
];

function roundToEven(n: number): number {
  return Math.round(n / 2) * 2;
}

export function resolutionPresets(config: Config): ResolutionPreset[] {
  const { width: baseWidth, height: baseHeight } = config.video;
  const ratio = baseWidth / baseHeight;

  return SCALES.map(({ key, label, factor }) => {
    const width = roundToEven(baseWidth * factor);
    const height = roundToEven(width / ratio);
    return { key, label: `${label} (${width}×${height})`, width, height };
  });
}

/** The preset a project resolves to, falling back to the base ("hd") preset. */
export function resolvePresetDimensions(
  config: Config,
  key: string | undefined,
): { width: number; height: number } {
  if (!key) return config.video;
  const preset = resolutionPresets(config).find((p) => p.key === key);
  if (!preset) throw new Error(`No such resolution preset: ${key}`);
  return { width: preset.width, height: preset.height };
}
