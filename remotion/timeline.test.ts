import { describe, it, expect } from "vitest";
import {
  activeCueAt,
  crossfadeFor,
  durationInFrames,
  visibleShotsAt,
  type TimelineShot,
} from "./timeline";

const CROSSFADE = 500;

const shots: TimelineShot[] = [
  { src: "a.png", startMs: 0, endMs: 4000 },
  { src: "b.png", startMs: 4000, endMs: 8000 },
  { src: "c.png", startMs: 8000, endMs: 12000 },
];

describe("visibleShotsAt", () => {
  it("shows exactly one shot in the middle of its window", () => {
    const visible = visibleShotsAt(2000, shots, CROSSFADE);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.shot.src).toBe("a.png");
    expect(visible[0]!.opacity).toBe(1);
  });

  // A gap here is a black frame in the finished video.
  it("never leaves the screen empty at any point on the timeline", () => {
    for (let ms = 0; ms <= 12000; ms += 50) {
      const visible = visibleShotsAt(ms, shots, CROSSFADE);
      const total = visible.reduce((sum, entry) => sum + entry.opacity, 0);
      expect(total, `nothing visible at ${ms}ms`).toBeGreaterThan(0);
    }
  });

  it("overlaps the outgoing and incoming shots during a crossfade", () => {
    const visible = visibleShotsAt(4250, shots, CROSSFADE);
    expect(visible.map((v) => v.shot.src)).toEqual(["a.png", "b.png"]);
    expect(visible[0]!.opacity).toBeCloseTo(0.5, 1);
    expect(visible[1]!.opacity).toBe(1);
  });

  it("holds the final shot to the end rather than fading to black", () => {
    const atEnd = visibleShotsAt(12000, shots, CROSSFADE);
    expect(atEnd).toHaveLength(1);
    expect(atEnd[0]!.shot.src).toBe("c.png");
    expect(atEnd[0]!.opacity).toBe(1);

    // Audio can outrun the last cue slightly; the image must still be there.
    const past = visibleShotsAt(13000, shots, CROSSFADE);
    expect(past[0]!.opacity).toBe(1);
  });

  it("drives progress from 0 to 1 across a shot's own window", () => {
    expect(visibleShotsAt(0, shots, CROSSFADE)[0]!.progress).toBe(0);
    expect(visibleShotsAt(2000, shots, CROSSFADE)[0]!.progress).toBeCloseTo(0.5, 5);
    const last = visibleShotsAt(3999, shots, CROSSFADE).find((v) => v.shot.src === "a.png")!;
    expect(last.progress).toBeGreaterThan(0.99);
  });

  it("copes with a single shot", () => {
    const one: TimelineShot[] = [{ src: "only.png", startMs: 0, endMs: 5000 }];
    expect(visibleShotsAt(0, one, CROSSFADE)[0]!.opacity).toBe(1);
    expect(visibleShotsAt(5000, one, CROSSFADE)[0]!.opacity).toBe(1);
  });

  it("returns nothing when there are no shots, rather than throwing", () => {
    expect(visibleShotsAt(1000, [], CROSSFADE)).toEqual([]);
  });
});

describe("crossfadeFor", () => {
  it("leaves a long shot's crossfade alone", () => {
    expect(crossfadeFor({ src: "a.png", startMs: 0, endMs: 15_000 }, 500)).toBe(500);
  });

  // Half a second of dissolve on a 1.5-second shot is a third of it spent
  // half-transparent, which reads as mush rather than as a cut.
  it("shortens the crossfade on a shot too brief to spend 500ms fading", () => {
    expect(crossfadeFor({ src: "a.png", startMs: 0, endMs: 1500 }, 500)).toBe(300);
  });

  it("never returns a negative fade for a zero-length shot", () => {
    expect(crossfadeFor({ src: "a.png", startMs: 1000, endMs: 1000 }, 500)).toBe(0);
  });
});

describe("visibleShotsAt at M9 pacing", () => {
  // The shape M9 actually produces: cuts every 1.5-3.5s rather than every 15s.
  const fast: TimelineShot[] = [
    { src: "a.png", startMs: 0, endMs: 1500 },
    { src: "b.png", startMs: 1500, endMs: 4000 },
    { src: "c.png", startMs: 4000, endMs: 7500 },
  ];

  it("never leaves the screen empty between fast cuts", () => {
    for (let ms = 0; ms <= 7500; ms += 10) {
      const total = visibleShotsAt(ms, fast, CROSSFADE).reduce((sum, e) => sum + e.opacity, 0);
      expect(total, `nothing visible at ${ms}ms`).toBeGreaterThan(0);
    }
  });

  it("spends less of a short shot in transition than the ceiling would", () => {
    // At 1.5s the fade is 300ms, so the incoming shot is already fully opaque
    // 300ms after its own start rather than 500ms in.
    const visible = visibleShotsAt(1800, fast, CROSSFADE);
    expect(visible.find((v) => v.shot.src === "b.png")!.opacity).toBe(1);
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
