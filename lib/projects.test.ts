import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { assets, characters, scenes } from "./db/schema";
import { listJobs } from "./queue";
import { createProject, regenerate } from "./projects";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

function imageAsset() {
  return db
    .insert(assets)
    .values({ kind: "image", path: "/tmp/i.png", mimeType: "image/png", bytes: 1 })
    .returning()
    .all()[0]!;
}

function projectWithSceneAndCharacter() {
  const project = createProject(db, { idea: "a plumber became mayor by wits" });
  const [character] = db
    .insert(characters)
    .values({
      projectId: project.id,
      name: "Hal",
      description: "d",
      appearanceTag: "a man",
      imagePrompt: "a prompt",
      imageAssetId: imageAsset().id,
      refInputName: "uploaded-hal.png",
    })
    .returning()
    .all();
  const [scene] = db
    .insert(scenes)
    .values({
      projectId: project.id,
      index: 0,
      description: "s",
      voiceoverScript: "One.",
      imagePrompt: "a prompt",
      storyboard: "a storyboard",
      imageAssetId: imageAsset().id,
    })
    .returning()
    .all();
  return { project, character: character!, scene: scene! };
}

// The whole point of scoping a redo to one row: clearing its artifact is what
// makes the stage's own "skip what's already there" logic pick it up, rather
// than requiring the stage to know about scoped redos at all.
describe("regenerate — per-row scoping", () => {
  it("clears only the targeted scene's prompt for an elements redo", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", sceneId: scene.id, direction: "darker" });

    const after = db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!;
    expect(after.imagePrompt).toBeNull();
    expect(after.storyboard).toBeNull();
    expect(after.imageAssetId).toBe(scene.imageAssetId);
  });

  it("clears only the targeted scene's image for a scene_images redo", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "scene_images", sceneId: scene.id });

    const after = db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!;
    expect(after.imageAssetId).toBeNull();
    expect(after.imagePrompt).toBe("a prompt");
  });

  it("clears only the targeted character's portrait for a character_images redo", () => {
    const { project, character } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "character_images", characterId: character.id });

    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageAssetId).toBeNull();
    expect(after.imagePrompt).toBeNull();
    expect(after.refInputName).toBeNull();
    expect(after.appearanceTag).toBe("a man");
  });

  it("does not touch other scenes when one is scoped", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    const [other] = db
      .insert(scenes)
      .values({
        projectId: project.id,
        index: 1,
        description: "other",
        voiceoverScript: "Two.",
        imagePrompt: "untouched prompt",
      })
      .returning()
      .all();

    regenerate(db, project.id, { target: "elements", sceneId: scene.id });

    expect(db.select().from(scenes).where(eq(scenes.id, other!.id)).get()!.imagePrompt).toBe(
      "untouched prompt",
    );
  });

  it("carries sceneId and direction through to the enqueued job's payload", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", sceneId: scene.id, direction: "darker" });

    const job = listJobs(db, { projectId: project.id }).find((j) => j.type === "elements");
    expect(job?.payload).toMatchObject({ sceneId: scene.id, direction: "darker" });
  });

  it("leaves every scene alone when no sceneId is given", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements" });

    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!.imagePrompt).toBe(
      "a prompt",
    );
  });
});
