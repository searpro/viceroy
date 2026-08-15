import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { narrativeStyles, voiceStyles, imageStyles, captionStyles } from "./db/schema";
import { createProject } from "./projects";
import {
  captionStyleSchema,
  createCaptionStyle,
  createImageStyle,
  createNarrativeStyle,
  createVoiceStyle,
  deleteCaptionStyle,
  deleteImageStyle,
  deleteNarrativeStyle,
  deleteVoiceStyle,
  imageStyleSchema,
  listCaptionStyles,
  listImageStyles,
  listNarrativeStyles,
  listVoiceStyles,
  narrativeStyleSchema,
  updateCaptionStyle,
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
};

const IMAGE_INPUT = {
  name: "Custom image",
  description: "d",
  promptPrefix: "photo, ",
  promptSuffix: ", 35mm",
};

const CAPTION_INPUT = {
  name: "Custom caption",
  description: "d",
  fontFamily: "Georgia, serif",
  fontSize: 60,
  fontWeight: 700,
  color: "#ffcc00",
  outlineColor: "#000000",
  outlineWidth: 8,
  bottomOffset: 0.2,
  uppercase: true,
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

  it("does not have the .partial() schema inject defaults on an omitted patch field", () => {
    const patch = voiceStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("ttsInstruct");
    expect(patch).not.toHaveProperty("deliveryCues");

    const created = createVoiceStyle(db, VOICE_INPUT);
    const updated = updateVoiceStyle(db, created.id, patch);
    expect(updated.ttsInstruct).toBe(VOICE_INPUT.ttsInstruct);
    expect(updated.deliveryCues).toBe(VOICE_INPUT.deliveryCues);
  });
});

describe("image styles", () => {
  it("creates, lists and updates a custom style", () => {
    const created = createImageStyle(db, IMAGE_INPUT);
    expect(listImageStyles(db).map((s) => s.id)).toContain(created.id);

    const updated = updateImageStyle(db, created.id, { promptSuffix: ", vintage" });
    expect(updated.promptSuffix).toBe(", vintage");
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

  it("does not have the .partial() schema inject defaults on an omitted patch field", () => {
    const patch = imageStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("promptPrefix");
    expect(patch).not.toHaveProperty("promptSuffix");

    const created = createImageStyle(db, IMAGE_INPUT);
    const updated = updateImageStyle(db, created.id, patch);
    expect(updated.promptPrefix).toBe(IMAGE_INPUT.promptPrefix);
    expect(updated.promptSuffix).toBe(IMAGE_INPUT.promptSuffix);
  });
});

describe("caption styles", () => {
  it("creates, lists and updates a custom style", () => {
    const created = createCaptionStyle(db, CAPTION_INPUT);
    expect(listCaptionStyles(db).map((s) => s.id)).toContain(created.id);

    const updated = updateCaptionStyle(db, created.id, { fontSize: 90 });
    expect(updated.fontSize).toBe(90);
    expect(updated.color).toBe(CAPTION_INPUT.color);
  });

  it("refuses to delete a built-in style", () => {
    const builtin = db.select().from(captionStyles).all().find((s) => s.isBuiltin)!;
    expect(() => deleteCaptionStyle(db, builtin.id)).toThrow(/built-in/);
  });

  it("refuses to delete a style a project depends on", () => {
    const created = createCaptionStyle(db, CAPTION_INPUT);
    createProject(db, { idea: "a plumber became mayor by wits", captionStyleId: created.id });
    expect(() => deleteCaptionStyle(db, created.id)).toThrow(/used by an existing project/);
  });

  it("does not have the .partial() schema inject defaults on an omitted patch field", () => {
    const patch = captionStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("fontSize");
    expect(patch).not.toHaveProperty("bottomOffset");

    const created = createCaptionStyle(db, CAPTION_INPUT);
    const updated = updateCaptionStyle(db, created.id, patch);
    expect(updated.fontSize).toBe(CAPTION_INPUT.fontSize);
    expect(updated.bottomOffset).toBe(CAPTION_INPUT.bottomOffset);
  });
});
