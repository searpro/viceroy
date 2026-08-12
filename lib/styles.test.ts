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
  imageStyleSchema,
  listImageStyles,
  listNarrativeStyles,
  listVoiceStyles,
  narrativeStyleSchema,
  updateImageStyle,
  updateNarrativeStyle,
  updateVoiceStyle,
  voiceStyleSchema,
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

  // Regression: z.object(...).partial() still applies a field's own
  // .default() to a key that is simply absent from the patch. A route
  // handler parsing a PATCH body through narrativeStyleSchema.partial()
  // must not silently reset targetSceneCount/targetWordCount on an edit
  // that never touched them.
  it("does not have the .partial() schema inject defaults for an omitted patch field", () => {
    const patch = narrativeStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("targetSceneCount");
    expect(patch).not.toHaveProperty("targetWordCount");

    const created = createNarrativeStyle(db, NARRATIVE_INPUT);
    const updated = updateNarrativeStyle(db, created.id, patch);
    expect(updated.targetSceneCount).toBe(NARRATIVE_INPUT.targetSceneCount);
    expect(updated.targetWordCount).toBe(NARRATIVE_INPUT.targetWordCount);
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

  it("does not have the .partial() schema inject a default model on an omitted patch field", () => {
    const patch = voiceStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("model");

    const created = createVoiceStyle(db, VOICE_INPUT);
    const updated = updateVoiceStyle(db, created.id, patch);
    expect(updated.model).toBe(VOICE_INPUT.model);
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

  it("does not have the .partial() schema inject empty defaultParams on an omitted patch field", () => {
    const patch = imageStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("defaultParams");
    expect(patch).not.toHaveProperty("promptPrefix");

    const created = createImageStyle(db, IMAGE_INPUT);
    const updated = updateImageStyle(db, created.id, patch);
    expect(updated.defaultParams).toEqual(IMAGE_INPUT.defaultParams);
    expect(updated.promptPrefix).toBe(IMAGE_INPUT.promptPrefix);
  });
});
