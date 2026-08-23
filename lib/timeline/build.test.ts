import { describe, expect, it } from "vitest";
import {
  buildTimeline,
  DEFAULT_GUIDE_STRENGTH,
  DEFAULT_SEGMENT_DURATION_MS,
  seedSegments,
  segmentEndMs,
  type TimelineSegmentRow,
  type TimelineShotInput,
} from "./build";
import { minimumDurationMs } from "./speech";

function shot(overrides: Partial<TimelineShotInput> = {}): TimelineShotInput {
  return {
    id: "shot-1",
    sceneId: "1",
    index: 0,
    keyframePrompt: "her face lit by a guttering lantern",
    motionPrompt: "slow push in as the flame dies",
    shotType: "close-up",
    cameraAngle: "eye-level",
    cameraMovement: "push-in",
    lens: "telephoto",
    characterIds: ["char-1"],
    dialogue: [],
    durationHintMs: 4000,
    keyframeAssetId: "asset-1",
    ...overrides,
  };
}

function row(overrides: Partial<TimelineSegmentRow> = {}): TimelineSegmentRow {
  return {
    id: "seg-1",
    index: 0,
    sceneId: "1",
    label: "Scene 1 · close-up",
    durationMs: 4000,
    videoPrompt: "slow push in",
    keyframePrompt: "her face",
    startKeyframeAssetId: "asset-1",
    endKeyframeAssetId: null,
    guideStrength: 1,
    dialogue: [],
    ambience: "",
    foley: "",
    music: "",
    camera: { shotType: "close-up", angle: "eye-level", movement: "push-in", lens: "telephoto" },
    characterIds: [],
    notes: "",
    ...overrides,
  };
}

describe("seedSegments", () => {
  it("produces one segment per shot, in the shot list's order", () => {
    const seeded = seedSegments([
      shot({ id: "b", index: 1, sceneId: "2" }),
      shot({ id: "a", index: 0, sceneId: "1" }),
    ]);

    expect(seeded.map((s) => s.shotListItemId)).toEqual(["a", "b"]);
    expect(seeded.map((s) => s.index)).toEqual([0, 1]);
  });

  it("reindexes from zero rather than trusting the shot list's own numbering", () => {
    // A shot list whose indices start at 1 (or skip one, after a scoped redo)
    // must still produce a contiguous timeline — a gap here would become a gap
    // in the compiled frame layout.
    const seeded = seedSegments([shot({ id: "a", index: 7 }), shot({ id: "b", index: 12 })]);
    expect(seeded.map((s) => s.index)).toEqual([0, 1]);
  });

  it("carries the two prompt registers into distinct fields", () => {
    const [seeded] = seedSegments([shot()]);
    expect(seeded!.videoPrompt).toBe("slow push in as the flame dies");
    expect(seeded!.keyframePrompt).toBe("her face lit by a guttering lantern");
  });

  it("falls back to the shared default when a duration hint is missing or absurd", () => {
    for (const hint of [null, 0, -1, Number.NaN]) {
      const [seeded] = seedSegments([shot({ durationHintMs: hint })]);
      expect(seeded!.durationMs).toBe(DEFAULT_SEGMENT_DURATION_MS);
    }
  });

  it("leaves the end keyframe unset — nothing upstream produces one", () => {
    const [seeded] = seedSegments([shot()]);
    expect(seeded!.endKeyframeAssetId).toBeNull();
    expect(seeded!.startKeyframeAssetId).toBe("asset-1");
    expect(seeded!.guideStrength).toBe(DEFAULT_GUIDE_STRENGTH);
  });

  it("floors a segment's duration by the speech it has to fit", () => {
    // A row hand-edited to a short duration, or written before M7.2 applied
    // this floor upstream, would otherwise become a clip with the end of the
    // line cut off.
    const speaking = shot({
      durationHintMs: 1000,
      dialogue: [
        {
          characterId: "c1",
          characterName: "Reyna",
          parenthetical: "",
          line: "It was under the stairs the whole time, exactly where he said it would be.",
          delivery: "level",
        },
      ],
    });
    const [seeded] = seedSegments([speaking]);
    expect(seeded!.durationMs).toBeGreaterThan(1000);
    expect(seeded!.durationMs).toBe(minimumDurationMs(speaking.dialogue));
  });

  it("leaves a silent segment's duration exactly as the shot list set it", () => {
    const [seeded] = seedSegments([shot({ durationHintMs: 2000, dialogue: [] })]);
    expect(seeded!.durationMs).toBe(2000);
  });

  it("labels a segment from its scene and shot type, degrading when either is blank", () => {
    expect(seedSegments([shot()])[0]!.label).toBe("Scene 1 · close-up");
    expect(seedSegments([shot({ shotType: "" })])[0]!.label).toBe("Scene 1");
    expect(seedSegments([shot({ sceneId: "", shotType: "" })])[0]!.label).toBe("Shot 1");
  });
});

describe("buildTimeline", () => {
  const settings = {
    projectId: "p1",
    targetId: "ltx-director",
    fps: 24,
    width: 768,
    height: 1344,
    aspectRatio: "9:16",
    globalPrompt: "grimy harbour town, overcast",
  };

  it("derives startMs as the prefix sum of every earlier duration", () => {
    const timeline = buildTimeline(settings, [
      row({ id: "a", index: 0, durationMs: 4000 }),
      row({ id: "b", index: 1, durationMs: 2500 }),
      row({ id: "c", index: 2, durationMs: 6000 }),
    ]);

    expect(timeline.segments.map((s) => s.startMs)).toEqual([0, 4000, 6500]);
    expect(timeline.segments.map(segmentEndMs)).toEqual([4000, 6500, 12500]);
    expect(timeline.totalDurationMs).toBe(12500);
  });

  it("sorts by index rather than trusting the caller's array order", () => {
    const timeline = buildTimeline(settings, [
      row({ id: "c", index: 2, durationMs: 1000 }),
      row({ id: "a", index: 0, durationMs: 4000 }),
      row({ id: "b", index: 1, durationMs: 2000 }),
    ]);

    expect(timeline.segments.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(timeline.segments.map((s) => s.startMs)).toEqual([0, 4000, 6000]);
  });

  it("reflows every later segment when one duration changes", () => {
    const before = buildTimeline(settings, [
      row({ id: "a", index: 0, durationMs: 4000 }),
      row({ id: "b", index: 1, durationMs: 4000 }),
      row({ id: "c", index: 2, durationMs: 4000 }),
    ]);
    const after = buildTimeline(settings, [
      row({ id: "a", index: 0, durationMs: 6000 }),
      row({ id: "b", index: 1, durationMs: 4000 }),
      row({ id: "c", index: 2, durationMs: 4000 }),
    ]);

    expect(before.segments.map((s) => s.startMs)).toEqual([0, 4000, 8000]);
    expect(after.segments.map((s) => s.startMs)).toEqual([0, 6000, 10000]);
    expect(after.totalDurationMs).toBe(14000);
  });

  it("is empty, not broken, for a timeline with no segments", () => {
    const timeline = buildTimeline(settings, []);
    expect(timeline.segments).toEqual([]);
    expect(timeline.totalDurationMs).toBe(0);
  });

  it("carries settings through and defaults audio to null", () => {
    const timeline = buildTimeline(settings, [row()]);
    expect(timeline).toMatchObject({ projectId: "p1", fps: 24, width: 768, aspectRatio: "9:16" });
    expect(timeline.audio).toBeNull();
  });

  it("agrees with how runPrevis lays the same shots out", () => {
    // Previs prefix-sums the same durations with the same fallback, so a
    // timeline's total and the animatic's length are the same number by
    // construction rather than by coincidence.
    const shots = [
      shot({ id: "a", index: 0, durationHintMs: 3000 }),
      shot({ id: "b", index: 1, durationHintMs: null }),
      shot({ id: "c", index: 2, durationHintMs: 5000 }),
    ];
    const seeded = seedSegments(shots);
    const timeline = buildTimeline(
      settings,
      seeded.map((s, i) => ({ ...s, id: `seg-${i}` })),
    );

    const previsTotal = shots.reduce((sum, s) => sum + (s.durationHintMs ?? DEFAULT_SEGMENT_DURATION_MS), 0);
    expect(timeline.totalDurationMs).toBe(previsTotal);
  });
});
