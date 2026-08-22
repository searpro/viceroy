import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { narrativeStyles, voiceStyles, imageStyles, captionStyles, directionStyles } from "./db/schema";
import { createProject } from "./projects";
import {
  captionStyleSchema,
  createCaptionStyle,
  createDirectionStyle,
  createImageStyle,
  createNarrativeStyle,
  createVoiceStyle,
  deleteCaptionStyle,
  deleteDirectionStyle,
  deleteImageStyle,
  deleteNarrativeStyle,
  deleteVoiceStyle,
  directionStyleSchema,
  imageStylePatchSchema,
  imageStyleSchema,
  listCaptionStyles,
  listDirectionStyles,
  listImageStyles,
  listNarrativeStyles,
  listVoiceStyles,
  narrativeStyleSchema,
  updateCaptionStyle,
  updateDirectionStyle,
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
  sceneGuidance: "v",
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

const DIRECTION_INPUT = {
  name: "Custom direction",
  description: "d",
  genreGuidance: "grounded drama",
  toneGuidance: "sincere",
  pacingGuidance: "patient",
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

  // A diffusion prompt has no "not": prefix/suffix are concatenated onto the
  // *positive* prompt, so "no artificial CGI appearance" there asks for CGI.
  // A user-authored style shipped with exactly that phrase, which is what this
  // guards. The built-ins are held to the same rule by a seed test.
  it("refuses a negation in the prompt prefix or suffix", () => {
    for (const field of ["promptPrefix", "promptSuffix"] as const) {
      const result = imageStyleSchema.safeParse({
        ...IMAGE_INPUT,
        [field]: ", no artificial CGI appearance",
      });
      expect(result.success, `${field} must reject a negation`).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/negative prompt/);
      }
    }
  });

  it("applies the same rule on a patch, which is how an existing style is edited", () => {
    expect(imageStylePatchSchema.safeParse({ promptSuffix: ", without blur" }).success).toBe(false);
    expect(imageStylePatchSchema.safeParse({ promptSuffix: ", film grain" }).success).toBe(true);
  });

  // zod throws on .partial() over a refined schema — at runtime, with no type
  // error — so the patch shape is built from the plain fields rather than
  // derived from the refined one. Without this, every PATCH 500s.
  it("exposes a patch schema that does not throw when built", () => {
    expect(() => imageStylePatchSchema.safeParse({ name: "Renamed" })).not.toThrow();
    expect(imageStylePatchSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  // Guidance is read by the LLM composing a prompt, which is instructed about
  // negation and handles "avoid X" correctly — the rule is for text that
  // reaches the diffusion model verbatim, and must not spread beyond it.
  it("allows a negation in render guidance, which the LLM reads rather than the image model", () => {
    expect(
      imageStyleSchema.safeParse({ ...IMAGE_INPUT, renderGuidance: "avoid flat lighting" }).success,
    ).toBe(true);
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
    const patch = imageStylePatchSchema.parse({ description: "changed only" });
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

describe("direction styles", () => {
  it("creates, lists and updates a custom style", () => {
    const created = createDirectionStyle(db, DIRECTION_INPUT);
    expect(listDirectionStyles(db).map((s) => s.id)).toContain(created.id);

    const updated = updateDirectionStyle(db, created.id, { toneGuidance: "wry" });
    expect(updated.toneGuidance).toBe("wry");
    expect(updated.genreGuidance).toBe(DIRECTION_INPUT.genreGuidance);
  });

  it("refuses to delete a built-in style", () => {
    const builtin = db.select().from(directionStyles).all().find((s) => s.isBuiltin)!;
    expect(() => deleteDirectionStyle(db, builtin.id)).toThrow(/built-in/);
  });

  it("deletes a custom style that nothing references", () => {
    const created = createDirectionStyle(db, DIRECTION_INPUT);
    deleteDirectionStyle(db, created.id);
    expect(listDirectionStyles(db).map((s) => s.id)).not.toContain(created.id);
  });

  it("refuses to delete a style a project depends on", () => {
    const created = createDirectionStyle(db, DIRECTION_INPUT);
    createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
      directionStyleId: created.id,
    });
    expect(() => deleteDirectionStyle(db, created.id)).toThrow(/used by an existing project/);
  });

  it("does not have the .partial() schema inject defaults on an omitted patch field", () => {
    const patch = directionStyleSchema.partial().parse({ description: "changed only" });
    expect(patch).not.toHaveProperty("genreGuidance");
    expect(patch).not.toHaveProperty("pacingGuidance");

    const created = createDirectionStyle(db, DIRECTION_INPUT);
    const updated = updateDirectionStyle(db, created.id, patch);
    expect(updated.genreGuidance).toBe(DIRECTION_INPUT.genreGuidance);
    expect(updated.pacingGuidance).toBe(DIRECTION_INPUT.pacingGuidance);
  });

  // A narrative-format project (the default) never resolves a direction
  // style at all — only the Development chain reads one.
  it("is not resolved for a short_video_narrative project", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    expect(project.directionStyleId).toBeNull();
  });
});
