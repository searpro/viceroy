import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { narrativeStyles, voiceStyles, imageStyles } from "./db/schema";
import { createProject } from "./projects";
import {
  createImageStyle,
  createNarrativeStyle,
  createVoiceStyle,
  deleteImageStyle,
  deleteNarrativeStyle,
  deleteVoiceStyle,
  listImageStyles,
  listNarrativeStyles,
  listVoiceStyles,
  updateImageStyle,
  updateNarrativeStyle,
  updateVoiceStyle,
} from "./styles";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

const NARRATIVE_INPUT = {
  name: "Custom narrative",
  description: "d",
  plannerGuidance: "p",
  writingGuidance: "w",
  visualGuidance: "v",
  evaluationChecklist: [{ key: "clarity", description: "Is it clear" }],
  targetSceneCount: 6,
  targetWordCount: 200,
};

const VOICE_INPUT = {
  name: "Custom voice",
  description: "d",
  ttsInstruct: "speak warmly",
  deliveryCues: "slow down on the turn",
  model: "qwen3-tts-voicedesign",
};

const IMAGE_INPUT = {
  name: "Custom image",
  description: "d",
  promptPrefix: "photo, ",
  promptSuffix: ", 35mm",
  negativePrompt: "blurry",
  model: "flux2-klein-4b",
  defaultParams: { steps: 20 },
};

describe("narrative styles", () => {
  it("creates, lists and updates a custom style", () => {
    const created = createNarrativeStyle(db, NARRATIVE_INPUT);
    expect(listNarrativeStyles(db).map((s) => s.id)).toContain(created.id);

    const updated = updateNarrativeStyle(db, created.id, { description: "changed" });
    expect(updated.description).toBe("changed");
    expect(updated.name).toBe("Custom narrative");
  });

  it("refuses to delete a built-in style", () => {
    const builtin = db.select().from(narrativeStyles).all().find((s) => s.isBuiltin)!;
    expect(() => deleteNarrativeStyle(db, builtin.id)).toThrow(/built-in/);
  });

  it("deletes a custom style that nothing references", () => {
    const created = createNarrativeStyle(db, NARRATIVE_INPUT);
    deleteNarrativeStyle(db, created.id);
    expect(listNarrativeStyles(db).map((s) => s.id)).not.toContain(created.id);
  });

  it("refuses to delete a style a project depends on", () => {
    const created = createNarrativeStyle(db, NARRATIVE_INPUT);
    createProject(db, { idea: "a plumber became mayor by wits", narrativeStyleId: created.id });
    expect(() => deleteNarrativeStyle(db, created.id)).toThrow(/used by an existing project/);
  });
});

describe("voice styles", () => {
  it("creates, lists and updates a custom style", () => {
    const created = createVoiceStyle(db, VOICE_INPUT);
    expect(listVoiceStyles(db).map((s) => s.id)).toContain(created.id);

    const updated = updateVoiceStyle(db, created.id, { ttsInstruct: "speak coldly" });
    expect(updated.ttsInstruct).toBe("speak coldly");
  });

  it("refuses to delete a built-in style", () => {
    const builtin = db.select().from(voiceStyles).all().find((s) => s.isBuiltin)!;
    expect(() => deleteVoiceStyle(db, builtin.id)).toThrow(/built-in/);
  });

  it("refuses to delete a style a project depends on", () => {
    const created = createVoiceStyle(db, VOICE_INPUT);
    createProject(db, { idea: "a plumber became mayor by wits", voiceStyleId: created.id });
    expect(() => deleteVoiceStyle(db, created.id)).toThrow(/used by an existing project/);
  });
});

describe("image styles", () => {
  it("creates, lists and updates a custom style", () => {
    const created = createImageStyle(db, IMAGE_INPUT);
    expect(listImageStyles(db).map((s) => s.id)).toContain(created.id);

    const updated = updateImageStyle(db, created.id, { negativePrompt: "watermark" });
    expect(updated.negativePrompt).toBe("watermark");
  });

  it("refuses to delete a built-in style", () => {
    const builtin = db.select().from(imageStyles).all().find((s) => s.isBuiltin)!;
    expect(() => deleteImageStyle(db, builtin.id)).toThrow(/built-in/);
  });

  it("refuses to delete a style a project depends on", () => {
    const created = createImageStyle(db, IMAGE_INPUT);
    createProject(db, { idea: "a plumber became mayor by wits", imageStyleId: created.id });
    expect(() => deleteImageStyle(db, created.id)).toThrow(/used by an existing project/);
  });
});
