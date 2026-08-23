import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatTimecode,
  groupIssues,
  issueSummary,
  layoutBlocks,
  rulerTicks,
  type TimelineSegmentView,
} from "./timeline-view";

function segment(index: number, startMs: number, durationMs: number): TimelineSegmentView {
  return {
    id: `s${index}`,
    index,
    sceneId: "1",
    label: `Scene 1 · shot ${index + 1}`,
    startMs,
    durationMs,
    videoPrompt: "",
    keyframePrompt: "",
    startKeyframeAssetId: null,
    endKeyframeAssetId: null,
    guideStrength: 1,
    dialogue: [],
    ambience: "",
    foley: "",
    music: "",
    camera: { shotType: "wide", angle: "eye-level", movement: "static", lens: "standard" },
    characterIds: [],
    notes: "",
  };
}

describe("formatTimecode", () => {
  it("reads in minutes, seconds and tenths", () => {
    expect(formatTimecode(0)).toBe("0:00.0");
    expect(formatTimecode(4000)).toBe("0:04.0");
    expect(formatTimecode(12_500)).toBe("0:12.5");
    expect(formatTimecode(65_400)).toBe("1:05.4");
  });

  it("shows hours only when there are any", () => {
    expect(formatTimecode(3_600_000)).toBe("1:00:00.0");
    expect(formatTimecode(3_599_000)).toBe("59:59.0");
  });

  it("never renders a negative timecode", () => {
    expect(formatTimecode(-1)).toBe("0:00.0");
  });

  it("truncates rather than rounds into the next second", () => {
    // 1999ms is 1.9s, not 2.0 — a block whose out-point rounded up would
    // overlap the next one's in-point on screen.
    expect(formatTimecode(1999)).toBe("0:01.9");
  });
});

describe("formatDuration", () => {
  it("reads as a length, not a position", () => {
    expect(formatDuration(4000)).toBe("4.0s");
    expect(formatDuration(2500)).toBe("2.5s");
  });
});

describe("layoutBlocks", () => {
  it("sizes each block in proportion to its duration", () => {
    const blocks = layoutBlocks(
      [segment(0, 0, 4000), segment(1, 4000, 2000), segment(2, 6000, 6000)],
      12_000,
    );
    expect(blocks.map((b) => Math.round(b.widthPercent))).toEqual([33, 17, 50]);
    expect(blocks.map((b) => Math.round(b.leftPercent))).toEqual([0, 33, 50]);
  });

  it("keeps a very short segment clickable", () => {
    const blocks = layoutBlocks([segment(0, 0, 100), segment(1, 100, 60_000)], 60_100);
    expect(blocks[0]!.widthPercent).toBeGreaterThanOrEqual(2);
  });

  it("renders something clickable for a zero-length timeline rather than dividing by zero", () => {
    const blocks = layoutBlocks([segment(0, 0, 0), segment(1, 0, 0)], 0);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(Number.isFinite(block.widthPercent)).toBe(true);
    expect(blocks.map((b) => b.leftPercent)).toEqual([0, 50]);
  });

  it("is empty for an empty timeline", () => {
    expect(layoutBlocks([], 0)).toEqual([]);
  });
});

describe("rulerTicks", () => {
  it("picks an interval that keeps a short timeline readable", () => {
    const ticks = rulerTicks(12_000);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(ticks.length).toBeLessThanOrEqual(13);
    expect(ticks[0]).toMatchObject({ ms: 0, percent: 0, label: "0:00.0" });
  });

  it("picks a coarser interval for a five-minute film", () => {
    const ticks = rulerTicks(300_000);
    expect(ticks.length).toBeLessThanOrEqual(13);
    // Hard-coding one-second marks would put 300 of them on this track.
    expect(ticks[1]!.ms).toBeGreaterThanOrEqual(30_000);
  });

  it("is empty for a zero-length timeline", () => {
    expect(rulerTicks(0)).toEqual([]);
  });
});

describe("groupIssues", () => {
  it("separates whole-timeline problems from per-segment ones", () => {
    const { bySegment, overall } = groupIssues([
      { severity: "error", segmentIndex: null, message: "fps" },
      { severity: "error", segmentIndex: 1, message: "too long" },
      { severity: "warning", segmentIndex: 1, message: "no prompt" },
    ]);
    expect(overall).toHaveLength(1);
    expect(bySegment.get(1)).toHaveLength(2);
    expect(bySegment.get(0)).toBeUndefined();
  });
});

describe("issueSummary", () => {
  it("is null when nothing is wrong", () => {
    expect(issueSummary([])).toBeNull();
  });

  it("counts each severity, singular and plural", () => {
    expect(
      issueSummary([
        { severity: "error", segmentIndex: null, message: "a" },
        { severity: "error", segmentIndex: 0, message: "b" },
        { severity: "warning", segmentIndex: 1, message: "c" },
      ]),
    ).toBe("2 errors, 1 warning");
    expect(issueSummary([{ severity: "warning", segmentIndex: null, message: "c" }])).toBe("1 warning");
  });
});
