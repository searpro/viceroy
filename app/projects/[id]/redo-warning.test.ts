import { describe, it, expect } from "vitest";
import { INVALIDATION_CHAIN } from "@/lib/projects";
import type { Detail } from "./detail-types";
import { REDO_CHAIN, describeRedoLoss, redoConfirmation } from "./redo-warning";

function detail(overrides: Partial<Detail> = {}): Detail {
  return {
    project: {
      id: "p",
      idea: "an idea",
      synopsis: "a synopsis",
      story: "a story",
      stage: "render",
      format: "short_video_narrative",
      mode: "manual",
      awaitingReview: true,
      failureReason: null,
    },
    evaluations: [],
    nextStep: { kind: "complete", reason: "the video is rendered" },
    stalled: false,
    scenes: [],
    characters: [],
    cues: [],
    jobs: [],
    ...overrides,
  };
}

const scene = (i: number, withImage = true) => ({
  id: `s${i}`,
  index: i,
  description: "d",
  storyboard: "sb",
  imagePrompt: "p",
  voiceoverScript: "One.",
  imageAssetId: withImage ? `a${i}` : null,
});

const character = (i: number, imageSource: "generated" | "uploaded" = "generated") => ({
  id: `c${i}`,
  name: `Person ${i}`,
  description: "d",
  appearanceTag: "a man",
  imagePrompt: "p",
  imageAssetId: `ca${i}`,
  imageSource,
});

// The warning is only honest if it lists what the server actually deletes.
// Two lists in two modules drift; this is the check that they have not.
describe("REDO_CHAIN", () => {
  it("matches the server's invalidation order exactly", () => {
    expect([...REDO_CHAIN]).toEqual([...INVALIDATION_CHAIN]);
  });
});

describe("describeRedoLoss", () => {
  it("warns about nothing when the project has not built anything yet", () => {
    const early = detail({ project: { ...detail().project, story: null } });
    expect(describeRedoLoss("synopsis", early)).toEqual([]);
    expect(redoConfirmation("synopsis", early)).toBeNull();
  });

  it("counts what a synopsis redo destroys, in the project's own numbers", () => {
    const loss = describeRedoLoss(
      "synopsis",
      detail({
        scenes: [scene(0), scene(1), scene(2)],
        characters: [character(0)],
        voiceover: { id: "v", ttsInstruct: "x", audioAssetId: "au", durationMs: 1000 },
        cues: [{ id: "q", index: 0, text: "One.", heardText: null, startMs: 0, endMs: 10 }],
        render: { id: "r", assetId: "ra", status: "ready" },
      }),
    );

    expect(loss).toEqual([
      "the written narration",
      "3 scenes",
      "1 cast member",
      "the recorded narration",
      "the caption timings",
      "the finished video",
    ]);
  });

  // The one loss the pipeline cannot undo: it can redraw a portrait, but it
  // cannot recover a photo the user chose.
  it("calls out uploaded photos as unrecoverable", () => {
    const loss = describeRedoLoss(
      "story",
      detail({ characters: [character(0), character(1, "uploaded")] }),
    );
    expect(loss).toContain("2 cast members — including 1 photo you uploaded, which cannot be recovered");
  });

  it("does not double-count portraits and images when the cast itself is going", () => {
    const loss = describeRedoLoss(
      "story",
      detail({ scenes: [scene(0), scene(1)], characters: [character(0)] }),
    );
    expect(loss.filter((l) => l.includes("portrait"))).toEqual([]);
    expect(loss.filter((l) => l.includes("scene image"))).toEqual([]);
  });

  it("does count them when only they are going", () => {
    const loss = describeRedoLoss(
      "character_images",
      detail({ scenes: [scene(0), scene(1)], characters: [character(0)] }),
    );
    expect(loss).toContain("2 scene images");
    expect(loss).not.toContain("1 cast member");
  });

  it("never reaches back past the stage being redone", () => {
    const loss = describeRedoLoss(
      "voiceover",
      detail({ scenes: [scene(0)], characters: [character(0)] }),
    );
    expect(loss).not.toContain("the written narration");
    expect(loss.some((l) => l.includes("scene"))).toBe(false);
  });

  it("singularises counts", () => {
    const loss = describeRedoLoss("story", detail({ scenes: [scene(0)] }));
    expect(loss).toContain("1 scene");
  });

  it("does not warn about a render that never finished", () => {
    const loss = describeRedoLoss(
      "voiceover",
      detail({ render: { id: "r", assetId: null, status: "failed" } }),
    );
    expect(loss).not.toContain("the finished video");
  });
});
