import { describe, it, expect } from "vitest";
import { computeAutoAdvance, computeInitialStep, stepForNextStep, STEPS, type StepId } from "./stepper";
import type { Detail } from "./detail-types";

function baseDetail(overrides: Partial<Detail> = {}): Detail {
  return {
    project: {
      id: "p1",
      idea: "idea",
      synopsis: null,
      story: null,
      stage: "draft",
      format: "short_video_narrative",
      mode: "auto",
      awaitingReview: false,
      failureReason: null,
    },
    evaluations: [],
    nextStep: { kind: "run", type: "synopsis", reason: "no synopsis yet" },
    stalled: false,
    scenes: [],
    characters: [],
    devArtifacts: [],
    locations: [],
    props: [],
    continuityFacts: [],
    storyboardPanels: [],
    render: null,
    voiceover: null,
    cues: [],
    jobs: [],
    ...overrides,
  };
}

describe("stepForNextStep", () => {
  const cases: [string, StepId][] = [
    ["synopsis", "story"],
    ["story", "story"],
    ["story_eval", "story"],
    ["story_revise", "story"],
    ["elements", "cast"], // confirmed decision: elements -> Cast, not Scenes
    ["character_images", "cast"],
    ["scene_images", "scenes"],
    ["voiceover", "narration"],
    ["subtitle_align", "narration"],
    ["render", "video"],
  ];

  for (const [type, expected] of cases) {
    it(`maps nextStep.type "${type}" to step "${expected}"`, () => {
      const nextStep: Detail["nextStep"] = { kind: "run", type, reason: "because" };
      expect(stepForNextStep(nextStep)).toBe(expected);
    });
  }
});

describe("computeInitialStep", () => {
  it("lands on video when a render already exists (complete)", () => {
    const detail = baseDetail({ nextStep: { kind: "complete", reason: "done" } });
    expect(computeInitialStep(detail)).toBe("video");
  });

  it("lands on cast when nextStep.type is elements, per the confirmed decision", () => {
    const detail = baseDetail({ nextStep: { kind: "run", type: "elements", reason: "need cast" } });
    expect(computeInitialStep(detail)).toBe("cast");
  });

  it("lands on story for a fresh project", () => {
    const detail = baseDetail({ nextStep: { kind: "run", type: "synopsis", reason: "new" } });
    expect(computeInitialStep(detail)).toBe("story");
  });
});

describe("isComplete", () => {
  const storyStep = STEPS.find((s) => s.id === "story")!;
  const castStep = STEPS.find((s) => s.id === "cast")!;
  const scenesStep = STEPS.find((s) => s.id === "scenes")!;
  const narrationStep = STEPS.find((s) => s.id === "narration")!;
  const videoStep = STEPS.find((s) => s.id === "video")!;

  it("story is complete once story text exists", () => {
    expect(storyStep.isComplete(baseDetail({ project: { ...baseDetail().project, story: "a story" } }))).toBe(
      true,
    );
    expect(storyStep.isComplete(baseDetail())).toBe(false);
  });

  it("cast is complete once every character has a portrait", () => {
    const withPortraits = baseDetail({
      characters: [
        {
          id: "c1",
          name: "A",
          description: "",
          arc: null,
          appearanceTag: null,
          imagePrompt: null,
          imageAssetId: "asset1",
          imageSource: "generated",
        },
      ],
    });
    expect(castStep.isComplete(withPortraits)).toBe(true);

    const withoutPortraits = baseDetail({
      characters: [
        {
          id: "c1",
          name: "A",
          description: "",
          arc: null,
          appearanceTag: null,
          imagePrompt: null,
          imageAssetId: null,
          imageSource: "generated",
        },
      ],
    });
    expect(castStep.isComplete(withoutPortraits)).toBe(false);
  });

  it("scenes is complete once every scene has an image", () => {
    const withImages = baseDetail({
      scenes: [
        {
          id: "s1",
          index: 0,
          description: "",
          storyboard: null,
          imagePrompt: null,
          voiceoverScript: "",
          imageAssetId: "asset1",
        },
      ],
    });
    expect(scenesStep.isComplete(withImages)).toBe(true);
    expect(scenesStep.isComplete(baseDetail())).toBe(false);
  });

  it("narration is complete once audio and cues exist", () => {
    const complete = baseDetail({
      voiceover: { id: "v1", ttsInstruct: "", audioAssetId: "asset1", durationMs: 1000 },
      cues: [{ id: "cue1", index: 0, text: "hi", heardText: "hi", startMs: 0, endMs: 500 }],
    });
    expect(narrationStep.isComplete(complete)).toBe(true);
    expect(narrationStep.isComplete(baseDetail())).toBe(false);
  });

  it("video is complete once a render asset exists", () => {
    expect(videoStep.isComplete(baseDetail({ render: { id: "r1", assetId: "a1", status: "succeeded" } }))).toBe(
      true,
    );
    expect(videoStep.isComplete(baseDetail())).toBe(false);
  });
});

describe("computeAutoAdvance", () => {
  it("does not move the active step once the user has manually navigated", () => {
    const detail = baseDetail({ nextStep: { kind: "run", type: "render", reason: "ready" } });
    expect(computeAutoAdvance("story", true, detail)).toBe("story");
  });

  it("moves forward automatically while the user hasn't navigated", () => {
    const detail = baseDetail({ nextStep: { kind: "run", type: "voiceover", reason: "next" } });
    expect(computeAutoAdvance("story", false, detail)).toBe("narration");
  });

  it("never moves the viewed step backward", () => {
    const detail = baseDetail({ nextStep: { kind: "run", type: "synopsis", reason: "redo" } });
    expect(computeAutoAdvance("video", false, detail)).toBe("video");
  });
});
