import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config";
import {
  ASPECT_RATIO_KEYS,
  ASPECT_RATIOS,
  defaultAspectFor,
  resolutionPresets,
  resolvePresetDimensions,
  sourceImageFor,
} from "./resolution";

const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });

describe("resolutionPresets", () => {
  it("keeps every preset at the base resolution's exact aspect ratio", () => {
    const ratio = config.video.width / config.video.height;
    for (const preset of resolutionPresets(config)) {
      expect(preset.width / preset.height).toBeCloseTo(ratio, 4);
    }
  });

  it("gives every dimension an even number, since h264 needs one", () => {
    for (const preset of resolutionPresets(config)) {
      expect(preset.width % 2).toBe(0);
      expect(preset.height % 2).toBe(0);
    }
  });

  it("has the hd preset match the base config resolution exactly", () => {
    const hd = resolutionPresets(config).find((p) => p.key === "hd")!;
    expect(hd.width).toBe(config.video.width);
    expect(hd.height).toBe(config.video.height);
  });
});

describe("resolvePresetDimensions", () => {
  it("falls back to the base config resolution when no key is given", () => {
    expect(resolvePresetDimensions(config, undefined)).toEqual(config.video);
  });

  it("resolves a known preset key", () => {
    const standard = resolutionPresets(config).find((p) => p.key === "standard")!;
    expect(resolvePresetDimensions(config, "standard")).toEqual({
      width: standard.width,
      height: standard.height,
    });
  });

  it("refuses an unknown key", () => {
    expect(() => resolvePresetDimensions(config, "cinematic-8k")).toThrow(/No such resolution preset/);
  });
});

describe("per-project aspect ratio (M7.1 PR-E)", () => {
  it("returns the configured source frame unchanged for a 9:16 project", () => {
    // The whole narrative pipeline is 9:16, and this change must be a no-op for
    // it — same pixels, same dimensions, byte-identical generations.
    expect(sourceImageFor(config, "9:16")).toEqual(config.sourceImage);
    expect(sourceImageFor(config, null)).toEqual(config.sourceImage);
  });

  it("re-cuts the same pixel budget to another shape, rather than growing it", () => {
    const budget = config.sourceImage.width * config.sourceImage.height;
    for (const key of ASPECT_RATIO_KEYS) {
      const { width, height } = sourceImageFor(config, key);
      // Within 10%: the multiple-of-16 grid cannot hit every ratio exactly, but
      // a landscape project must not silently cost several times a vertical
      // one — the budget is what this machine can render (F12), not a hint.
      expect(Math.abs(width * height - budget) / budget).toBeLessThan(0.1);
    }
  });

  it("keeps every generated dimension on the multiple-of-16 grid", () => {
    // Finding F4: stable-diffusion.cpp rounds a non-conforming dimension *up*
    // rather than refusing it, silently changing the ratio it was asked for.
    for (const key of ASPECT_RATIO_KEYS) {
      const { width, height } = sourceImageFor(config, key);
      expect(width % 16).toBe(0);
      expect(height % 16).toBe(0);
    }
  });

  it("holds each shape to within a quarter of a percent of its true ratio", () => {
    // This is what replaces `resolveConfig`'s old source-vs-video guard: source
    // and output are now derived from one ratio, so they agree by construction
    // — but only if the derivation is actually faithful to that ratio.
    for (const { key, ratio } of ASPECT_RATIOS) {
      const source = sourceImageFor(config, key);
      const output = resolvePresetDimensions(config, "hd", key);
      expect(Math.abs(source.width / source.height / ratio - 1)).toBeLessThan(0.0025);
      expect(Math.abs(output.width / output.height / ratio - 1)).toBeLessThan(0.0025);
    }
  });

  it("beats naive rounding on the ratio that needs it", () => {
    // 2.39:1 is the case that motivated a search: round(sqrt(budget * ratio))
    // lands on 896x368, a 1.9% error, where 880x368 is 0.05% off for 2% of the
    // budget. A frame at the wrong shape is letterboxed or cropped at render
    // time — a visible defect — while a frame slightly under budget is faster.
    const { width, height } = sourceImageFor(config, "2.39:1");
    expect(Math.abs(width / height / 2.39 - 1)).toBeLessThan(0.001);
  });

  it("gives a landscape and a vertical project the same render cost at one preset", () => {
    // "HD" should mean the same amount of work whatever shape the project is —
    // scaling by area rather than by width is what makes that true.
    const vertical = resolvePresetDimensions(config, "hd", "9:16");
    const landscape = resolvePresetDimensions(config, "hd", "16:9");
    const ratio = (landscape.width * landscape.height) / (vertical.width * vertical.height);
    expect(Math.abs(ratio - 1)).toBeLessThan(0.01);
  });

  it("keeps the hd preset byte-identical to the base config for a 9:16 project", () => {
    expect(resolvePresetDimensions(config, "hd", "9:16")).toEqual(config.video);
  });

  it("defaults a movie format to landscape and a narrative short to vertical", () => {
    // The concrete bug this closes: every format inherited the global 9:16, so
    // `short_movie` projects rendered portrait.
    expect(defaultAspectFor("short_video_narrative")).toBe("9:16");
    expect(defaultAspectFor("short_movie")).toBe("16:9");
    expect(defaultAspectFor("feature_film")).toBe("16:9");
  });

  it("refuses an aspect it has no definition for", () => {
    expect(() => sourceImageFor(config, "3:7")).toThrow(/No such aspect ratio/);
  });
});
