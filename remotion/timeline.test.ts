import { describe, it, expect } from "vitest";
import { activeCueAt, durationInFrames, visibleScenesAt, type TimelineScene } from "./timeline";

const CROSSFADE = 500;

const scenes: TimelineScene[] = [
  { src: "a.png", startMs: 0, endMs: 4000 },
  { src: "b.png", startMs: 4000, endMs: 8000 },
  { src: "c.png", startMs: 8000, endMs: 12000 },
];

describe("visibleScenesAt", () => {
  it("shows exactly one scene in the middle of its window", () => {
    const visible = visibleScenesAt(2000, scenes, CROSSFADE);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.scene.src).toBe("a.png");
    expect(visible[0]!.opacity).toBe(1);
  });

  // A gap here is a black frame in the finished video.
  it("never leaves the screen empty at any point on the timeline", () => {
    for (let ms = 0; ms <= 12000; ms += 50) {
      const visible = visibleScenesAt(ms, scenes, CROSSFADE);
      const total = visible.reduce((sum, entry) => sum + entry.opacity, 0);
      expect(total, `nothing visible at ${ms}ms`).toBeGreaterThan(0);
    }
  });

  it("overlaps the outgoing and incoming scenes during a crossfade", () => {
    const visible = visibleScenesAt(4250, scenes, CROSSFADE);
    expect(visible.map((v) => v.scene.src)).toEqual(["a.png", "b.png"]);
    expect(visible[0]!.opacity).toBeCloseTo(0.5, 1);
    expect(visible[1]!.opacity).toBe(1);
  });

  it("holds the final scene to the end rather than fading to black", () => {
    const atEnd = visibleScenesAt(12000, scenes, CROSSFADE);
    expect(atEnd).toHaveLength(1);
    expect(atEnd[0]!.scene.src).toBe("c.png");
    expect(atEnd[0]!.opacity).toBe(1);

    // Audio can outrun the last cue slightly; the image must still be there.
    const past = visibleScenesAt(13000, scenes, CROSSFADE);
    expect(past[0]!.opacity).toBe(1);
  });

  it("drives progress from 0 to 1 across a scene's own window", () => {
    expect(visibleScenesAt(0, scenes, CROSSFADE)[0]!.progress).toBe(0);
    expect(visibleScenesAt(2000, scenes, CROSSFADE)[0]!.progress).toBeCloseTo(0.5, 5);
    const last = visibleScenesAt(3999, scenes, CROSSFADE).find((v) => v.scene.src === "a.png")!;
    expect(last.progress).toBeGreaterThan(0.99);
  });

  it("copes with a single scene", () => {
    const one: TimelineScene[] = [{ src: "only.png", startMs: 0, endMs: 5000 }];
    expect(visibleScenesAt(0, one, CROSSFADE)[0]!.opacity).toBe(1);
    expect(visibleScenesAt(5000, one, CROSSFADE)[0]!.opacity).toBe(1);
  });

  it("returns nothing when there are no scenes, rather than throwing", () => {
    expect(visibleScenesAt(1000, [], CROSSFADE)).toEqual([]);
  });
});

describe("activeCueAt", () => {
  const cues = [
    { text: "first", startMs: 0, endMs: 1000 },
    { text: "second", startMs: 1000, endMs: 2000 },
  ];

  it("picks the cue covering the moment", () => {
    expect(activeCueAt(500, cues)?.text).toBe("first");
    expect(activeCueAt(1500, cues)?.text).toBe("second");
  });

  // Half-open intervals: at exactly 1000ms the second cue owns the frame, so
  // two captions can never be on screen at once.
  it("hands over at the boundary without overlapping", () => {
    expect(activeCueAt(1000, cues)?.text).toBe("second");
  });

  it("shows nothing in a gap or past the end", () => {
    expect(activeCueAt(2000, cues)).toBeUndefined();
    expect(activeCueAt(-1, cues)).toBeUndefined();
  });
});

describe("durationInFrames", () => {
  it("rounds up so the last word is never clipped", () => {
    expect(durationInFrames(1000, 30)).toBe(30);
    expect(durationInFrames(1001, 30)).toBe(31);
    expect(durationInFrames(178960, 30)).toBe(5369);
  });

  it("never returns a zero-length composition", () => {
    expect(durationInFrames(0, 30)).toBe(1);
  });
});
