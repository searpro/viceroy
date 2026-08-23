import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config";
import {
  ASPECT_RATIO_KEYS,
  ASPECT_RATIOS,
  aspectCss,
  defaultAspectFor,
  projectAspect,
  RESOLUTION_KEYS,
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

describe("projectAspect", () => {
  // The bug this exists to prevent: `aspect_ratio` is nullable, every project
  // created before M7.1 PR-E has none, and the four call sites that needed a
  // fallback all hardcoded "9:16". A `short_movie` from before that column
  // therefore generated portrait panels, reported a 9:16 timeline frame, and
  // was drawn into portrait review boxes — while its format plainly said
  // otherwise.
  it("falls back to the format's own shape, not to vertical", () => {
    expect(projectAspect({ format: "short_movie", aspectRatio: null })).toBe("16:9");
    expect(projectAspect({ format: "feature_film", aspectRatio: null })).toBe("16:9");
    expect(projectAspect({ format: "short_video_narrative", aspectRatio: null })).toBe("9:16");
  });

  it("prefers the stored shape whenever there is one", () => {
    expect(projectAspect({ format: "short_movie", aspectRatio: "4:5" })).toBe("4:5");
    expect(projectAspect({ format: "short_video_narrative", aspectRatio: "2.39:1" })).toBe("2.39:1");
  });

  it("treats an unrecognised stored value as absent rather than throwing", () => {
    // A row written by an older build, or by hand. Falling back beats a render
    // that 500s on a value the UI cannot even offer.
    expect(projectAspect({ format: "short_movie", aspectRatio: "21:9" })).toBe("16:9");
    expect(projectAspect({ format: "short_movie" })).toBe("16:9");
  });
});

describe("aspectCss", () => {
  it("emits a CSS aspect-ratio for the stored shape", () => {
    expect(aspectCss("16:9")).toBe(`${16 / 9} / 1`);
    expect(aspectCss("1:1")).toBe("1 / 1");
  });

  it("falls back through the format, so a movie thumbnail is not portrait", () => {
    expect(aspectCss(null, "short_movie")).toBe(`${16 / 9} / 1`);
    expect(aspectCss(null, "short_video_narrative")).toBe(`${9 / 16} / 1`);
  });
});

describe("lower resolution presets", () => {
  it("offers tiers below the configured output, for cheap review passes", () => {
    // A movie generates one image per storyboard beat and one per shot, so the
    // first pass over a sequence is about coverage, not grain — there was no
    // way to ask for less than 2/3 of full size.
    expect(RESOLUTION_KEYS).toContain("draft");
    expect(RESOLUTION_KEYS).toContain("low");

    const presets = resolutionPresets(config);
    const pixels = (key: string) => {
      const preset = presets.find((p) => p.key === key)!;
      return preset.width * preset.height;
    };
    expect(pixels("draft")).toBeLessThan(pixels("low"));
    expect(pixels("low")).toBeLessThan(pixels("standard"));
    expect(pixels("standard")).toBeLessThan(pixels("hd"));
  });

  it("keeps the existing tiers at the pixel counts they always had", () => {
    // Adding tiers must not move the ones projects are already stored at, or
    // `currentResolutionKey` would stop recognising them.
    const hd = resolutionPresets(config).find((p) => p.key === "hd")!;
    expect({ width: hd.width, height: hd.height }).toEqual(config.video);
  });

  it("holds the project's shape at every tier", () => {
    for (const aspect of ASPECT_RATIO_KEYS) {
      const ratio = ASPECT_RATIOS.find((a) => a.key === aspect)!.ratio;
      for (const preset of resolutionPresets(config, aspect)) {
        expect(preset.width / preset.height).toBeCloseTo(ratio, 1);
      }
    }
  });
});
