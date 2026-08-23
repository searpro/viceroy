import { describe, expect, it } from "vitest";
import { framesForMs, msForFrames, quantiseFrames, quantisedFramesForMs } from "./frames";

const LTX = { modulus: 8, remainder: 1 };

describe("framesForMs", () => {
  it("converts at the given rate", () => {
    expect(framesForMs(4000, 24)).toBe(96);
    expect(framesForMs(3375, 24)).toBe(81);
  });

  it("refuses a rate that cannot describe a duration", () => {
    expect(() => framesForMs(4000, 0)).toThrow(/0fps/);
    expect(() => framesForMs(Number.NaN, 24)).toThrow();
  });
});

describe("quantiseFrames", () => {
  it("lands on LTX's n % 8 == 1 grid", () => {
    for (const frames of [1, 9, 17, 40, 81, 96, 97, 200, 1000]) {
      expect(quantiseFrames(frames, LTX) % 8).toBe(1);
    }
  });

  it("picks the nearer conforming value", () => {
    expect(quantiseFrames(96, LTX)).toBe(97); // 96 is 1 above 89, 1 below 97 → tie, rounds up
    expect(quantiseFrames(90, LTX)).toBe(89);
    expect(quantiseFrames(95, LTX)).toBe(97);
  });

  it("rounds a tie up, so a clip is trimmed rather than made to hold a frame", () => {
    // 93 sits exactly between 89 and 97.
    expect(quantiseFrames(93, LTX)).toBe(97);
  });

  it("never returns less than the smallest conforming value", () => {
    expect(quantiseFrames(0, LTX)).toBe(1);
    expect(quantiseFrames(-40, LTX)).toBe(1);
    // A quantum whose remainder is below one frame still yields a real count.
    expect(quantiseFrames(0, { modulus: 4, remainder: 0 })).toBe(4);
  });

  it("passes frames through unquantised when a target has no grid", () => {
    expect(quantiseFrames(96, null)).toBe(96);
    expect(quantiseFrames(0, null)).toBe(1);
  });

  it("refuses a nonsensical modulus", () => {
    expect(() => quantiseFrames(96, { modulus: 0, remainder: 1 })).toThrow(/modulus/);
  });
});

describe("msForFrames", () => {
  it("inverts framesForMs to within a frame", () => {
    for (const ms of [1000, 3375, 4000, 8000]) {
      const frames = framesForMs(ms, 24);
      expect(Math.abs(msForFrames(frames, 24) - ms)).toBeLessThanOrEqual(1000 / 24);
    }
  });
});

describe("quantisedFramesForMs", () => {
  it("is the pairing callers want", () => {
    expect(quantisedFramesForMs(4000, 24, LTX)).toBe(97);
    expect(quantisedFramesForMs(4000, 25, LTX)).toBe(97);
    expect(quantisedFramesForMs(8000, 24, LTX)).toBe(193);
  });
});
