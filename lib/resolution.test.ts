import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config";
import { resolutionPresets, resolvePresetDimensions } from "./resolution";

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
