import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, captionStyles, projects, scenes, voiceovers } from "../db/schema";
import { claim, enqueue } from "../queue";
import { createProject } from "../projects";
import { captionStyleSchema, DEFAULT_CAPTION_STYLE } from "../../remotion/schema";
import { resolveRenderCaptionStyle, runRender } from "./render";
import { stubContext } from "./test-support";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

/**
 * These exercise the refusals only. Everything past them starts a headless
 * browser and renders for minutes, which no unit test should do — the render
 * itself is verified against a real MP4 with ffprobe (finding F7).
 */
function project(options: { timed?: boolean; images?: boolean; narrated?: boolean } = {}) {
  const created = createProject(db, { idea: "a plumber became mayor by wits" });
  claim(db);
  db.update(projects).set({ story: "One. Two." }).where(eq(projects.id, created.id)).run();

  const [asset] = db
    .insert(assets)
    .values({ kind: "image", path: "/tmp/x.png", mimeType: "image/png", bytes: 1 })
    .returning()
    .all();

  db.insert(scenes)
    .values([
      {
        projectId: created.id,
        index: 0,
        description: "s0",
        voiceoverScript: "One.",
        ...(options.timed ? { startMs: 0, endMs: 1000 } : {}),
        ...(options.images ? { imageAssetId: asset!.id } : {}),
      },
    ])
    .run();

  if (options.narrated) {
    const [audio] = db
      .insert(assets)
      .values({ kind: "audio", path: "/tmp/n.wav", mimeType: "audio/wav", bytes: 1 })
      .returning()
      .all();
    db.insert(voiceovers)
      .values({
        projectId: created.id,
        script: "One. Two.",
        ttsInstruct: "x",
        audioAssetId: audio!.id,
        durationMs: 1000,
      })
      .run();
  }

  return created;
}

/**
 * A composition's zod schema documents its props; it does **not** fill
 * defaults into `inputProps` at render time. Passing `{}` therefore reaches
 * the component as `undefined` everywhere and renders — silently — as a 16px
 * serif caption pinned to the bottom edge by a `NaN` padding. Nothing throws.
 *
 * So the style has to be materialised before it is handed over, and any field
 * added to the schema later needs a default or this fails. See F22.
 */
describe("caption style defaults", () => {
  it("fills every field when given an empty object", () => {
    const parsed = captionStyleSchema.parse({});
    for (const [key, value] of Object.entries(parsed)) {
      expect(value, `captionStyle.${key} would reach the renderer undefined`).toBeDefined();
    }
  });

  it("produces a caption that is actually legible over a photograph", () => {
    const style = captionStyleSchema.parse({});
    expect(style.fontSize).toBeGreaterThan(40);
    expect(style.fontWeight).toBeGreaterThanOrEqual(700);
    // Without a stroke, white text vanishes against a bright frame.
    expect(style.outlineWidth).toBeGreaterThan(0);
    // Clear of the platform UI that overlays the bottom of a short-form video.
    expect(style.bottomOffset).toBeGreaterThan(0.1);
  });

  it("keeps an explicit override", () => {
    expect(captionStyleSchema.parse({ fontSize: 120, uppercase: true })).toMatchObject({
      fontSize: 120,
      uppercase: true,
    });
  });
});

describe("resolveRenderCaptionStyle", () => {
  it("falls back to the default for a project with no caption style row", () => {
    expect(resolveRenderCaptionStyle(undefined)).toEqual(DEFAULT_CAPTION_STYLE);
  });

  it("uses the project's caption style, stripped down to what the composition declares", () => {
    const [style] = db
      .insert(captionStyles)
      .values({
        name: "Loud",
        description: "d",
        fontSize: 120,
        uppercase: true,
      })
      .returning()
      .all();

    const resolved = resolveRenderCaptionStyle(style);
    expect(resolved).toMatchObject({ fontSize: 120, uppercase: true });
    expect(resolved).not.toHaveProperty("id");
    expect(resolved).not.toHaveProperty("name");
  });
});

describe("createProject caption style resolution", () => {
  it("resolves a project's caption style the same way as the other three", () => {
    const [style] = db
      .insert(captionStyles)
      .values({ name: "Custom Caption", description: "d", fontSize: 50 })
      .returning()
      .all();

    const created = createProject(db, {
      idea: "a plumber became mayor by wits",
      captionStyleId: style!.id,
    });
    expect(created.captionStyleId).toBe(style!.id);
  });

  it("falls back to the seeded default when none is specified", () => {
    const created = createProject(db, { idea: "a plumber became mayor by wits" });
    expect(created.captionStyleId).toBeTruthy();
  });
});

describe("runRender refusals", () => {
  it("refuses a project with no narration", async () => {
    const p = project({ timed: true, images: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no narration/);
  });

  it("refuses a project with no scenes", async () => {
    const p = createProject(db, { idea: "an idea long enough to pass" });
    db.insert(voiceovers)
      .values({ projectId: p.id, script: "x", ttsInstruct: "x", durationMs: 1000 })
      .run();
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no narration|no scenes/);
  });

  // Without alignment there is nothing to say when each image appears, and
  // guessing would produce a video whose pictures drift from its words.
  it("refuses when scenes have no timeline position", async () => {
    const p = project({ images: true, narrated: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no timeline position/);
  });

  it("refuses when a scene has no image", async () => {
    const p = project({ timed: true, narrated: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no image/);
  });
});
