import { describe, expect, it } from "vitest";
import { splitWords } from "./align";
import {
  assignShotTypes,
  estimateNarrationMs,
  partitionWords,
  planShotCount,
  type ShotPacing,
} from "./shots";

/** The seeded default: 2.5s target, 1.5s floor, 3.5s ceiling. */
const PACING: ShotPacing = { targetMs: 2500, minMs: 1500, maxMs: 3500 };

/** Mean shot duration, in ms, if `words` were covered by `shots` pictures. */
function meanShotMs(words: number, shots: number): number {
  return estimateNarrationMs(words) / shots;
}

describe("planShotCount", () => {
  it("covers an empty scene with nothing", () => {
    expect(planShotCount(0, PACING)).toBe(0);
  });

  it("leaves a scene inside the ceiling as one picture", () => {
    // 8 words at 150 wpm is 3.2s — under 3.5s, so it does not need cutting.
    expect(planShotCount(8, PACING)).toBe(1);
  });

  it("splits a scene that would otherwise hold past the ceiling", () => {
    // The defect being fixed: 60 words is 24s, which today is one still.
    expect(planShotCount(60, PACING)).toBeGreaterThan(1);
    expect(meanShotMs(60, planShotCount(60, PACING))).toBeLessThanOrEqual(PACING.maxMs);
  });

  it("keeps every mean shot duration inside the pacing window", () => {
    for (let words = 1; words <= 400; words++) {
      const shots = planShotCount(words, PACING);
      const mean = meanShotMs(words, shots);
      if (shots > 1) {
        expect(mean).toBeLessThanOrEqual(PACING.maxMs);
        expect(mean).toBeGreaterThanOrEqual(PACING.minMs);
      }
    }
  });

  it("prefers the ceiling over the target when they disagree", () => {
    // 9s against a 2.5s target rounds to 4 (2.25s each), not 3 (3s each) —
    // but either would be legal, so the check that matters is the ceiling.
    const shots = planShotCount(Math.round((9 * 150) / 60), PACING);
    expect(meanShotMs(Math.round((9 * 150) / 60), shots)).toBeLessThanOrEqual(PACING.maxMs);
  });

  it("never asks for more shots than there are words", () => {
    // Absurd pacing: every shot would want a fraction of a word.
    expect(planShotCount(3, { targetMs: 10, minMs: 5, maxMs: 20 })).toBeLessThanOrEqual(3);
  });

  it("follows the style's pacing rather than a constant", () => {
    const slow = planShotCount(300, { targetMs: 5000, minMs: 4000, maxMs: 6000 });
    const fast = planShotCount(300, { targetMs: 1500, minMs: 1000, maxMs: 2000 });
    expect(fast).toBeGreaterThan(slow);
  });
});

describe("partitionWords", () => {
  const script =
    "The lift doors opened onto an empty floor. Dust hung in the strip lights. " +
    "She stepped out and listened. Somewhere below her, a door closed. " +
    "Nobody was supposed to be here tonight.";

  it("returns nothing for empty narration", () => {
    expect(partitionWords("", 4)).toEqual([]);
    expect(partitionWords("   ", 4)).toEqual([]);
  });

  it("tiles the narration exactly — no gaps, no overlaps, none empty", () => {
    const total = splitWords(script).length;
    for (let count = 1; count <= 8; count++) {
      const ranges = partitionWords(script, count);
      expect(ranges[0]!.startWord).toBe(0);
      expect(ranges[ranges.length - 1]!.endWord).toBe(total - 1);
      for (const range of ranges) expect(range.endWord).toBeGreaterThanOrEqual(range.startWord);
      for (let i = 1; i < ranges.length; i++) {
        expect(ranges[i]!.startWord).toBe(ranges[i - 1]!.endWord + 1);
      }
    }
  });

  it("gives one range for one shot", () => {
    expect(partitionWords(script, 1)).toEqual([
      { startWord: 0, endWord: splitWords(script).length - 1 },
    ]);
  });

  it("pulls a cut onto a sentence boundary when one is close", () => {
    // Five sentences, five shots: every cut should land on a sentence start.
    const starts: number[] = [];
    let cursor = 0;
    for (const sentence of script.split(/(?<=\.)\s+/)) {
      starts.push(cursor);
      cursor += splitWords(sentence).length;
    }
    const ranges = partitionWords(script, 5);
    for (const range of ranges) expect(starts).toContain(range.startWord);
  });

  it("still cuts a scene made of one unbroken sentence", () => {
    const runOn = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const ranges = partitionWords(runOn, 4);
    expect(ranges).toHaveLength(4);
    expect(ranges.map((r) => r.endWord - r.startWord + 1)).toEqual([10, 10, 10, 10]);
  });

  it("never returns more ranges than there are words", () => {
    const ranges = partitionWords("two words", 9);
    expect(ranges).toHaveLength(2);
  });
});

describe("assignShotTypes", () => {
  it("opens on an establishing shot and then varies", () => {
    const types = assignShotTypes(5);
    expect(types[0]).toBe("establishing");
    expect(new Set(types).size).toBeGreaterThan(1);
  });

  it("leaves a single-shot scene as a plain medium", () => {
    expect(assignShotTypes(1)).toEqual(["medium"]);
  });

  it("includes reference-free coverage, which is what keeps the bill down", () => {
    // A frame with no face needs no reference portrait: ~51s against ~142s
    // (F12, F30). Alternating them is a cost decision as much as a visual one.
    expect(assignShotTypes(6)).toContain("insert");
  });

  it("returns one type per shot", () => {
    for (let n = 0; n <= 12; n++) expect(assignShotTypes(n)).toHaveLength(n);
  });
});
