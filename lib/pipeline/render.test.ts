import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, captionStyles, projects, sceneShots, scenes, voiceovers } from "../db/schema";
import { claim, enqueue } from "../queue";
import { createProject } from "../projects";
import { resolveConfig } from "../config";
import { captionStyleSchema, DEFAULT_CAPTION_STYLE } from "../../remotion/schema";
import { renderShots, resolveRenderCaptionStyle, resolveRenderDimensions, runRender } from "./render";
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

describe("createProject resolution", () => {
  it("resolves and stores a chosen resolution preset", () => {
    const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });
    const created = createProject(db, {
      idea: "a plumber became mayor by wits",
      resolutionKey: "standard",
    });
    expect(created.width).toBeLessThan(config.video.width);
    expect(created.height).toBeLessThan(config.video.height);
    expect(created.width! / created.height!).toBeCloseTo(config.video.width / config.video.height, 4);
  });

  it("falls back to the base config resolution when none is specified", () => {
    const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });
    const created = createProject(db, { idea: "a plumber became mayor by wits" });
    expect(created.width).toBe(config.video.width);
    expect(created.height).toBe(config.video.height);
  });
});

describe("resolveRenderDimensions", () => {
  const config = resolveConfig({ VICEROY_DATA_DIR: "./data" });

  it("falls back to config.video for a project with neither set", () => {
    expect(resolveRenderDimensions({ width: null, height: null }, config)).toEqual(config.video);
  });

  it("uses the project's own dimensions when set", () => {
    expect(resolveRenderDimensions({ width: 720, height: 1280 }, config)).toEqual({
      width: 720,
      height: 1280,
    });
  });
});

describe("renderShots", () => {
  /** Two scenes, `shotsPerScene` shots each, in a deliberately jumbled order. */
  function covered(shotsPerScene: number) {
    const created = project({ narrated: true });
    const [second] = db
      .insert(scenes)
      .values({ projectId: created.id, index: 1, description: "s1", voiceoverScript: "Two." })
      .returning()
      .all();
    const sceneRows = db.select().from(scenes).where(eq(scenes.projectId, created.id)).all();

    // Inserted back-to-front so the ordering under test is the code's, not the
    // insertion order's.
    for (const scene of [...sceneRows].reverse()) {
      for (let index = shotsPerScene - 1; index >= 0; index--) {
        db.insert(sceneShots)
          .values({
            projectId: created.id,
            sceneId: scene.id,
            index,
            startWord: index,
            endWord: index,
            startMs: index * 1000,
            endMs: (index + 1) * 1000,
          })
          .run();
      }
    }
    expect(second).toBeTruthy();
    return { project: created, sceneRows };
  }

  it("orders shots by scene, then by their place within the scene", () => {
    const { project: created, sceneRows } = covered(3);
    const shots = renderShots(db, created.id, sceneRows);

    expect(shots.map((shot) => shot.label)).toEqual([
      "scene-00-shot-00",
      "scene-00-shot-01",
      "scene-00-shot-02",
      "scene-01-shot-00",
      "scene-01-shot-01",
      "scene-01-shot-02",
    ]);
  });

  // A project finished before M9 has no shots at all: its scenes carry the
  // image and the timing directly. Falling back is what keeps it openable and
  // re-renderable rather than stranded.
  it("falls back to a pre-M9 project's scene stills", () => {
    const created = project({ timed: true, images: true, narrated: true });
    const sceneRows = db.select().from(scenes).where(eq(scenes.projectId, created.id)).all();

    const shots = renderShots(db, created.id, sceneRows);
    expect(shots).toHaveLength(1);
    expect(shots[0]!.label).toBe("scene-00");
    expect(shots[0]!.imageAssetId).toBe(sceneRows[0]!.imageAssetId);
    expect(shots[0]!.startMs).toBe(0);
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
  it("refuses when shots have no timeline position", async () => {
    const p = project({ images: true, narrated: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no timeline position/);
  });

  it("refuses when a shot has no image", async () => {
    const p = project({ timed: true, narrated: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no image/);
  });

  // The refusal has to follow the shots, not the scenes. A scene still holding
  // a pre-M9 image while its own shots have none would otherwise render a
  // video out of pictures nothing had drawn.
  it("refuses an untimed shot even when its scene is timed and illustrated", async () => {
    const p = project({ timed: true, images: true, narrated: true });
    const scene = db.select().from(scenes).where(eq(scenes.projectId, p.id)).get()!;
    db.insert(sceneShots)
      .values({ projectId: p.id, sceneId: scene.id, index: 0, startWord: 0, endWord: 0 })
      .run();

    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no timeline position/);
  });
});
