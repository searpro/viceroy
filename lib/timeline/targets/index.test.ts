import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMELINE_TARGET_ID,
  findTarget,
  resolveTarget,
  TIMELINE_TARGETS,
  TIMELINE_TARGET_IDS,
} from "./index";

describe("the target registry", () => {
  it("resolves a registered target and refuses an unknown one", () => {
    expect(resolveTarget("ltx-director").id).toBe("ltx-director");
    expect(findTarget("wan-vace")).toBeUndefined();
    expect(() => resolveTarget("wan-vace")).toThrow(/No such timeline target/);
  });

  it("has a default that is actually registered", () => {
    expect(TIMELINE_TARGET_IDS).toContain(DEFAULT_TIMELINE_TARGET_ID);
  });

  it("gives every target a distinct id", () => {
    expect(new Set(TIMELINE_TARGET_IDS).size).toBe(TIMELINE_TARGET_IDS.length);
  });

  /**
   * The point of the interface: a review surface renders fps choices, ceilings
   * and warnings out of `constraints` without knowing any target by name. A
   * target missing part of that contract would silently render a blank screen
   * rather than fail, so assert the contract here instead.
   */
  it("gives every target a usable constraint profile", () => {
    for (const target of TIMELINE_TARGETS) {
      expect(target.label.trim()).not.toBe("");
      expect(target.constraints.fpsChoices.length).toBeGreaterThan(0);
      expect(target.constraints.maxSegmentMs).toBeGreaterThan(0);
      expect(target.constraints.dimensionMultiple).toBeGreaterThan(0);
      expect(typeof target.validate).toBe("function");
      expect(typeof target.compile).toBe("function");
    }
  });
});
