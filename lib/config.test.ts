import { describe, it, expect } from "vitest";
import { resolveConfig } from "./config";

const base: Record<string, string | undefined> = { VICEROY_DATA_DIR: "./data" };

describe("resolveConfig", () => {
  it("defaults to a 432x768 source frame matching a 1080x1920 output", () => {
    const config = resolveConfig(base);
    expect(config.sourceImage).toEqual({ width: 432, height: 768 });
    expect(config.video).toEqual({ width: 1080, height: 1920 });
  });

  // F4: stable-diffusion.cpp rounds up instead of refusing, so a config that
  // looks fine produces frames at a different aspect ratio than requested.
  it.each([
    ["SOURCE_IMAGE_WIDTH", "360"],
    ["SOURCE_IMAGE_HEIGHT", "1080"],
  ])("rejects %s=%s because it is not a multiple of 16", (key, value) => {
    expect(() => resolveConfig({ ...base, [key]: value })).toThrow(/multiple of 16/);
  });

  it("accepts a larger source frame that is still a multiple of 16", () => {
    const config = resolveConfig({ ...base, SOURCE_IMAGE_WIDTH: "864", SOURCE_IMAGE_HEIGHT: "1536" });
    expect(config.sourceImage).toEqual({ width: 864, height: 1536 });
  });

  it("defaults reference images to 512x512, independent of the source frame", () => {
    const config = resolveConfig({});
    expect(config.referenceImage).toEqual({ width: 512, height: 512 });
    // Deliberately NOT the source frame's 9:16 — a reference is uploaded and
    // cited by name, never upscaled into the render, so it is free to be
    // framed for the subject rather than for the output.
    expect(config.referenceImage).not.toEqual(config.sourceImage);
  });

  it("does not hold reference images to the video's aspect ratio the way source frames are held", () => {
    // A 4:3 reference against a 9:16 video is fine and must not throw — the
    // guard exists for frames that get upscaled into the render, which
    // references never are.
    const config = resolveConfig({ REFERENCE_IMAGE_WIDTH: "640", REFERENCE_IMAGE_HEIGHT: "480" });
    expect(config.referenceImage).toEqual({ width: 640, height: 480 });
  });

  it("rejects a reference size that is not a multiple of 16, same as a source frame", () => {
    // Finding F4 applies to every dimension sent to stable-diffusion.cpp, not
    // just the ones that reach the render.
    expect(() => resolveConfig({ REFERENCE_IMAGE_WIDTH: "500" })).toThrow();
  });

  it("rejects a source frame whose ratio does not match the video", () => {
    expect(() =>
      resolveConfig({ ...base, SOURCE_IMAGE_WIDTH: "768", SOURCE_IMAGE_HEIGHT: "768" }),
    ).toThrow(/does not match/);
  });

  it("strips a trailing slash from the sd-api url so route joins stay clean", () => {
    expect(resolveConfig({ ...base, SD_API_URL: "http://localhost:3004/" }).sdApiUrl).toBe(
      "http://localhost:3004",
    );
  });
});
