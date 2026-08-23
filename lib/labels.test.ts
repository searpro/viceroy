import { describe, expect, it } from "vitest";
import { JOB_TYPES, PROJECT_FORMATS as SCHEMA_FORMATS } from "./db/schema";
import {
  DEV_CHAIN_ORDER,
  DEV_STAGE_LABELS,
  DEV_STAGE_PHASES,
  PROJECT_FORMATS,
  devStagePhase,
  formatLabel,
  isDevFormat,
  jobTypeFlow,
  jobTypeLabel,
  nextStepLabel,
} from "./labels";

// `lib/labels.ts` is client-safe and so cannot import lib/db/schema.ts, which
// pulls in better-sqlite3. That makes both vocabularies here hand-kept
// mirrors, and a mirror without a drift guard is a mirror that goes stale —
// the exact failure `dev-stages.test.ts` was written for after M7.1 PR-A moved
// casting and the label list did not follow.
describe("mirrors of lib/db/schema.ts", () => {
  it("lists every project format the schema accepts, and no others", () => {
    expect(PROJECT_FORMATS.map((entry) => entry.value)).toEqual([...SCHEMA_FORMATS]);
  });

  it("gives every job type a label that is not just the key back", () => {
    const unlabelled = JOB_TYPES.filter((type) => jobTypeLabel(type) === type);
    expect(unlabelled).toEqual([]);
  });

  it("assigns every dev-chain stage to exactly one phase", () => {
    const assigned = DEV_STAGE_PHASES.flatMap((phase) => phase.stages);
    expect([...assigned].sort()).toEqual([...DEV_CHAIN_ORDER].sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });
});

describe("formatLabel", () => {
  it("has a long form for the picker and a short one for a badge", () => {
    expect(formatLabel("short_video_narrative")).toBe("Short video (narrative slideshow)");
    expect(formatLabel("short_video_narrative", true)).toBe("Short video");
  });

  it("returns an unknown format unchanged rather than blank", () => {
    expect(formatLabel("interpretive_dance")).toBe("interpretive_dance");
  });
});

describe("isDevFormat", () => {
  it("counts everything but the narrative slideshow as a Development-chain project", () => {
    expect(isDevFormat("short_video_narrative")).toBe(false);
    for (const format of SCHEMA_FORMATS.filter((f) => f !== "short_video_narrative")) {
      expect(isDevFormat(format)).toBe(true);
    }
  });
});

describe("jobTypeFlow", () => {
  it("separates the two pipelines, which is what makes the jobs filter work", () => {
    expect(jobTypeFlow("scene_images")).toBe("narrative");
    expect(jobTypeFlow("subtitle_align")).toBe("narrative");
    expect(jobTypeFlow("storyboards")).toBe("development");
    expect(jobTypeFlow("screenplay_revision")).toBe("development");
  });

  it("puts every job type in one flow or the other", () => {
    for (const type of JOB_TYPES) {
      expect(["narrative", "development"]).toContain(jobTypeFlow(type));
    }
  });
});

describe("jobTypeLabel", () => {
  it("reads as a stage name, not a database key", () => {
    expect(jobTypeLabel("story_eval")).toBe("Story review");
    expect(jobTypeLabel("subtitle_align")).toBe("Caption alignment");
    expect(jobTypeLabel("script_breakdown")).toBe("Script breakdown");
    expect(jobTypeLabel("timeline")).toBe("Production timeline");
  });
});

describe("devStagePhase", () => {
  it("names the phase a stage belongs to", () => {
    expect(devStagePhase("concept")).toBe("Development");
    expect(devStagePhase("storyboards")).toBe("Visuals");
    expect(devStagePhase("timeline")).toBe("Handoff");
  });

  it("has nothing to say about a narrative job type", () => {
    expect(devStagePhase("scene_images")).toBeUndefined();
  });
});

describe("nextStepLabel", () => {
  it("reads a narrative job type off `type` and a dev stage off `stage`", () => {
    expect(nextStepLabel({ kind: "run", type: "voiceover" })).toBe("Voiceover");
    expect(nextStepLabel({ kind: "dev", stage: "production_design" })).toBe("Production design");
  });

  it("says something sensible when the pipeline is finished", () => {
    expect(nextStepLabel({ kind: "complete" })).toBe("Done");
  });
});

describe("DEV_STAGE_LABELS", () => {
  it("labels every stage in the chain", () => {
    for (const stage of DEV_CHAIN_ORDER) {
      expect(DEV_STAGE_LABELS[stage]).toBeTruthy();
    }
  });
});
