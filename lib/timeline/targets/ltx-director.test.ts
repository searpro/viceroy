import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineSegmentRow } from "../build";
import {
  composeSegmentPrompt,
  ltxDirectorTarget,
  ltxTotalFrames,
  type LtxTimelineData,
} from "./ltx-director";
import type { Timeline } from "../types";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const settings = {
  projectId: "p1",
  targetId: "ltx-director",
  fps: 24,
  width: 768,
  height: 1344,
  aspectRatio: "9:16",
  globalPrompt: "grimy harbour town, overcast, 35mm film grain",
};

function row(overrides: Partial<TimelineSegmentRow> = {}): TimelineSegmentRow {
  return {
    id: "seg-1",
    index: 0,
    sceneId: "1",
    label: "Scene 1 · wide",
    durationMs: 4000,
    videoPrompt: "slow push in as the flame dies",
    keyframePrompt: "her face lit by a guttering lantern",
    startKeyframeAssetId: "asset-a",
    endKeyframeAssetId: null,
    guideStrength: 1,
    dialogue: [],
    ambience: "",
    foley: "",
    music: "",
    camera: { shotType: "wide", angle: "eye-level", movement: "push-in", lens: "standard" },
    characterIds: [],
    notes: "",
    ...overrides,
  };
}

function speech(characterName: string, line: string, delivery: string, parenthetical = "") {
  return { characterId: `c-${characterName}`, characterName, parenthetical, line, delivery };
}

/**
 * Three segments: one pins an end frame, one speaks, and the score carries
 * across a cut — so the fixture exercises the composer, not just the frame
 * arithmetic.
 */
function sampleTimeline(): Timeline {
  return buildTimeline(settings, [
    row({
      id: "s0",
      index: 0,
      durationMs: 4000,
      videoPrompt: "slow push in on the harbour",
      ambience: "steady sea ambience, rigging knocking against masts",
      music: "sparse low strings, unhurried",
    }),
    row({
      id: "s1",
      index: 1,
      durationMs: 4000,
      videoPrompt: "she turns toward the door",
      startKeyframeAssetId: "asset-b",
      endKeyframeAssetId: "asset-c",
      guideStrength: 0.8,
      ambience: "steady sea ambience, rigging knocking against masts",
      music: "sparse low strings, unhurried",
      foley: "the squelch of boots on wet boards",
      dialogue: [speech("Reyna", "It was under the stairs.", "low, unhurried, faint coastal lilt", "(quietly)")],
    }),
    row({
      id: "s2",
      index: 2,
      durationMs: 6000,
      videoPrompt: "the lantern gutters out",
      startKeyframeAssetId: "asset-d",
      ambience: "wind only",
    }),
  ]);
}

describe("ltxDirectorTarget.compile", () => {
  it("matches the recorded payload fixture", () => {
    // Director documents `timeline_data` as "auto-managed; do not edit by
    // hand" — it has no compatibility contract, so this fixture is what makes
    // a change to our side of that interface show up in a diff rather than in
    // a failed GPU hour. It pins OUR output; it does not prove Director
    // accepts it (that is M8 PR0's spike, unknown U1).
    const recorded = JSON.parse(fs.readFileSync(path.join(fixtureDir, "ltx-director-payload.json"), "utf8"));
    expect(ltxDirectorTarget.compile(sampleTimeline())).toEqual(recorded);
  });

  it("quantises every segment onto LTX's n % 8 == 1 grid", () => {
    const payload = ltxDirectorTarget.compile(sampleTimeline());
    const lengths = payload.segment_lengths.split(",").map(Number);
    expect(lengths).toHaveLength(3);
    for (const length of lengths) expect(length % 8).toBe(1);
  });

  it("lays keyframes at frame offsets derived from the quantised lengths, not the raw ms", () => {
    const timeline = sampleTimeline();
    const payload = ltxDirectorTarget.compile(timeline);
    const data: LtxTimelineData = JSON.parse(payload.timeline_data);
    const lengths = payload.segment_lengths.split(",").map(Number);

    // Start keyframes sit at the running frame total; 4000ms at 24fps is 96
    // raw frames but 97 quantised, so an ms-derived offset would drift.
    const starts = data.segments.filter((s) => !s.isEndFrame).map((s) => s.start);
    expect(starts).toEqual([0, lengths[0], lengths[0]! + lengths[1]!]);
  });

  it("puts an end keyframe on the last frame of its own segment", () => {
    const payload = ltxDirectorTarget.compile(sampleTimeline());
    const data: LtxTimelineData = JSON.parse(payload.timeline_data);
    const lengths = payload.segment_lengths.split(",").map(Number);

    const endFrames = data.segments.filter((s) => s.isEndFrame);
    expect(endFrames).toHaveLength(1);
    expect(endFrames[0]!.start).toBe(lengths[0]! + lengths[1]! - 1);
  });

  it("emits one motion span per segment, covering the timeline without gaps", () => {
    const payload = ltxDirectorTarget.compile(sampleTimeline());
    const data: LtxTimelineData = JSON.parse(payload.timeline_data);

    let expectedStart = 0;
    for (const span of data.motionSegments) {
      expect(span.start).toBe(expectedStart);
      expectedStart += span.length;
    }
    expect(expectedStart).toBe(ltxTotalFrames(sampleTimeline()));
    expect(payload.local_prompts.split("|")).toEqual(data.motionSegments.map((s) => s.prompt));
  });

  it("names every image the manifest lists, and lists every image it names", () => {
    const payload = ltxDirectorTarget.compile(sampleTimeline());
    const data: LtxTimelineData = JSON.parse(payload.timeline_data);

    const referenced = new Set(data.segments.map((s) => s.imageFile));
    const manifested = new Set(payload.images.map((i) => i.fileName));
    expect(manifested).toEqual(referenced);
    expect(payload.images.map((i) => i.assetId).sort()).toEqual(["asset-a", "asset-b", "asset-c", "asset-d"]);
  });

  it("emits one guide strength per keyframe, in timeline_data order", () => {
    const payload = ltxDirectorTarget.compile(sampleTimeline());
    const data: LtxTimelineData = JSON.parse(payload.timeline_data);
    expect(payload.guide_strength.split(",")).toHaveLength(data.segments.length);
    // Segment 1 has two keyframes, both at its own 0.8.
    expect(payload.guide_strength).toBe("1,0.8,0.8,1");
  });

  it("defaults the render window to the whole timeline, and honours an explicit one", () => {
    const timeline = sampleTimeline();
    const total = ltxTotalFrames(timeline);

    expect(ltxDirectorTarget.compile(timeline)).toMatchObject({ start_frame: 0, end_frame: total });
    expect(ltxDirectorTarget.compile(timeline, { startFrame: 97, endFrame: 194 })).toMatchObject({
      start_frame: 97,
      end_frame: 194,
    });
  });

  it("leaves custom audio off while the Development chain has no narration", () => {
    const payload = ltxDirectorTarget.compile(sampleTimeline());
    expect(payload.use_custom_audio).toBe(false);
    expect(payload.inpaint_audio).toBe(false);
    expect(JSON.parse(payload.timeline_data).audioSegments).toEqual([]);
  });
});

describe("composeSegmentPrompt", () => {
  it("orders the paragraph the way LTX documents: shot, action, then audio last", () => {
    const [, second] = sampleTimeline().segments;
    const prompt = composeSegmentPrompt(second!, sampleTimeline().segments[0]);

    const shotAt = prompt.indexOf("Wide shot");
    const actionAt = prompt.indexOf("She turns toward the door");
    const ambienceAt = prompt.indexOf("Steady sea ambience");
    const dialogueAt = prompt.indexOf("Reyna says");

    expect(shotAt).toBeGreaterThanOrEqual(0);
    expect(actionAt).toBeGreaterThan(shotAt);
    expect(ambienceAt).toBeGreaterThan(actionAt);
    expect(dialogueAt).toBeGreaterThan(ambienceAt);
  });

  it("puts the authored words in quotation marks, unchanged", () => {
    const prompt = composeSegmentPrompt(sampleTimeline().segments[1]!);
    expect(prompt).toContain('"It was under the stairs."');
    // Terminated once. `stairs.".` is what naive punctuation produces, and it
    // is the kind of detail that survives into a generated performance.
    expect(prompt).not.toContain('."."');
    expect(prompt).not.toContain('.".');
  });

  it("takes prose, not tags — no weighting brackets or quality-tag tail", () => {
    const prompt = composeSegmentPrompt(sampleTimeline().segments[1]!);
    expect(prompt).not.toMatch(/[()][\d.]+[)]|\bmasterpiece\b|\bbest quality\b|<[^>]+>/i);
  });

  it("states audio continuity across a cut, as the multishot guidance asks", () => {
    const timeline = sampleTimeline();
    const carried = composeSegmentPrompt(timeline.segments[1]!, timeline.segments[0]);
    expect(carried).toContain("The score continues across the cut");
    expect(carried).toContain("the ambience continues");
  });

  it("does not echo the ambience string when saying it continues", () => {
    // Repeating "steady sea ambience, rigging knocking against masts" twice in
    // one paragraph reads as a second, different sound.
    const timeline = sampleTimeline();
    const carried = composeSegmentPrompt(timeline.segments[1]!, timeline.segments[0]);
    expect(carried.match(/Steady sea ambience/gi)).toHaveLength(1);
  });

  it("says what drops, not just what carries", () => {
    const timeline = sampleTimeline();
    const third = composeSegmentPrompt(timeline.segments[2]!, timeline.segments[1]);
    expect(third).toContain("The music drops");
    expect(third).toContain("the dialogue drops");
  });

  it("emits no continuity clause for the first segment, or when nothing changed", () => {
    const timeline = sampleTimeline();
    expect(composeSegmentPrompt(timeline.segments[0]!)).not.toContain("continues");
    expect(composeSegmentPrompt(timeline.segments[0]!)).not.toContain("drops");
  });

  it("is what the payload actually carries, in both places a prompt appears", () => {
    const timeline = sampleTimeline();
    const payload = ltxDirectorTarget.compile(timeline);
    const data: LtxTimelineData = JSON.parse(payload.timeline_data);
    const expected = composeSegmentPrompt(timeline.segments[1]!, timeline.segments[0]);

    expect(payload.local_prompts.split("|")[1]).toBe(expected);
    expect(data.motionSegments[1]!.prompt).toBe(expected);
  });
});

describe("ltxDirectorTarget.validate — dialogue", () => {
  const errors = (timeline: Timeline) =>
    ltxDirectorTarget.validate(timeline).filter((i) => i.severity === "error");
  const warnings = (timeline: Timeline) =>
    ltxDirectorTarget.validate(timeline).filter((i) => i.severity === "warning");

  const speaking = (durationMs: number, lines: ReturnType<typeof speech>[]) =>
    buildTimeline(settings, [row({ durationMs, dialogue: lines })]);

  it("errors when the line cannot fit the shot — the end would be cut off", () => {
    const long = speech(
      "Reyna",
      "It was under the stairs the whole time, exactly where he said it would be, and nobody thought to look",
      "level",
    );
    expect(errors(speaking(2000, [long]))[0]!.message).toContain("cut off");
  });

  it("accepts a line that comfortably fits", () => {
    expect(errors(speaking(8000, [speech("Reyna", "It was under the stairs.", "level")]))).toEqual([]);
  });

  it("warns about two speakers in one clip, where lip-sync degrades", () => {
    const two = speaking(12_000, [
      speech("Reyna", "It was under the stairs.", "level"),
      speech("Henry", "Then why did you look upstairs?", "gravelly"),
    ]);
    expect(warnings(two).map((i) => i.message).join(" ")).toContain("2 speakers");
  });

  it("warns once when a speaking character has no locked voice", () => {
    const unvoiced = speaking(8000, [
      speech("Reyna", "It was under the stairs.", ""),
      speech("Reyna", "Right where he said.", ""),
    ]);
    const voiceWarnings = warnings(unvoiced).filter((i) => i.message.includes("no locked voice"));
    expect(voiceWarnings).toHaveLength(1);
    expect(voiceWarnings[0]!.message).toContain("Reyna");
  });

  it("warns about 50fps only when there is dialogue to perform", () => {
    const spoken = buildTimeline({ ...settings, fps: 50 }, [
      row({ durationMs: 8000, dialogue: [speech("Reyna", "It was under the stairs.", "level")] }),
    ]);
    const silent = buildTimeline({ ...settings, fps: 50 }, [row({ durationMs: 8000 })]);

    expect(warnings(spoken).map((i) => i.message).join(" ")).toContain("50fps");
    expect(warnings(silent).map((i) => i.message).join(" ")).not.toContain("50fps");
  });

  it("does not complain about a missing video prompt when the segment speaks", () => {
    const spoken = buildTimeline(settings, [
      row({ durationMs: 8000, videoPrompt: "", dialogue: [speech("Reyna", "Under the stairs.", "level")] }),
    ]);
    expect(warnings(spoken).map((i) => i.message).join(" ")).not.toContain("Prompt Relay gets nothing");
  });
});

describe("ltxDirectorTarget.validate", () => {
  const errors = (timeline: Timeline) =>
    ltxDirectorTarget.validate(timeline).filter((i) => i.severity === "error");

  it("passes a well-formed timeline", () => {
    expect(errors(sampleTimeline())).toEqual([]);
  });

  it("flags a segment past the single-pass ceiling", () => {
    const timeline = buildTimeline(settings, [row({ durationMs: 25_000 })]);
    expect(errors(timeline)).toContainEqual(
      expect.objectContaining({ segmentIndex: 0, message: expect.stringContaining("single-pass ceiling") }),
    );
  });

  it("flags a segment with no start keyframe", () => {
    const timeline = buildTimeline(settings, [row({ startKeyframeAssetId: null })]);
    expect(errors(timeline)).toContainEqual(
      expect.objectContaining({ segmentIndex: 0, message: expect.stringContaining("No start keyframe") }),
    );
  });

  it("flags dimensions off the multiple-of-32 grid, naming a usable value", () => {
    const timeline = buildTimeline({ ...settings, width: 720, height: 1280 }, [row()]);
    const [issue] = errors(timeline);
    expect(issue).toMatchObject({ segmentIndex: null });
    // 720 ÷ 32 = 22.5 — the exact collision M8 detail's resolution section calls out.
    expect(issue!.message).toContain("736");
  });

  it("flags a frame rate LTX does not emit", () => {
    // 30fps is what the narrative pipeline's compositions use, so this is the
    // realistic way a wrong rate gets here.
    const timeline = buildTimeline({ ...settings, fps: 30 }, [row()]);
    expect(errors(timeline)).toContainEqual(
      expect.objectContaining({ segmentIndex: null, message: expect.stringContaining("30fps") }),
    );
  });

  it("flags an empty timeline", () => {
    expect(errors(buildTimeline(settings, []))).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("no segments") }),
    );
  });

  it("warns, rather than errors, about a missing prompt or a very short segment", () => {
    const timeline = buildTimeline(settings, [row({ videoPrompt: "  ", durationMs: 400 })]);
    const issues = ltxDirectorTarget.validate(timeline);
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("frames"), expect.stringContaining("Prompt Relay")]),
    );
  });
});
