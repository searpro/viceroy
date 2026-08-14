import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { assets, characters, scenes } from "./db/schema";
import { listJobs } from "./queue";
import { createProject, createProjectSchema, listAllJobs, regenerate } from "./projects";

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

// A story redo rewrites the narration those scene captions were grouped
// from — leaving the old rows in place would show stale captions forever,
// since `runElements` only groups sentences into scenes when none exist.
describe("regenerate — story redo clears stale scenes", () => {
  it("removes existing scenes so elements re-groups them from the new story", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "story", direction: "make it colder" });

    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()).toBeUndefined();
  });

  it("still enqueues the story job with the direction", () => {
    const { project } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "story", direction: "make it colder" });

    const job = listJobs(db, { projectId: project.id }).find((j) => j.type === "story");
    expect(job?.payload).toMatchObject({ direction: "make it colder" });
  });
});

// VIC-003: idea and context are mutually-exclusive inputs, validated
// conditionally on which `inputMode` was chosen.
describe("createProjectSchema", () => {
  it("accepts inputMode 'context' with a valid context string", () => {
    const result = createProjectSchema.safeParse({
      inputMode: "context",
      context: "A detailed account of a real event, long enough to pass the minimum.",
    });
    expect(result.success).toBe(true);
  });

  it("defaults inputMode to 'idea' when omitted, matching today's behaviour", () => {
    const result = createProjectSchema.safeParse({ idea: "a plumber became mayor by wits" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.inputMode).toBe("idea");
  });

  it("rejects Context-mode input with no context", () => {
    const result = createProjectSchema.safeParse({ inputMode: "context" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("context"))).toBe(true);
    }
  });

  it("rejects Context-mode input whose context is over the 8000-char cap", () => {
    const result = createProjectSchema.safeParse({
      inputMode: "context",
      context: "x".repeat(8001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts Context-mode input at exactly the 8000-char cap", () => {
    const result = createProjectSchema.safeParse({
      inputMode: "context",
      context: "x".repeat(8000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects Idea-mode input with a context field present but no idea", () => {
    const result = createProjectSchema.safeParse({
      inputMode: "idea",
      context: "some context that should not matter here",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("idea"))).toBe(true);
    }
  });
});

describe("createProject — input modes", () => {
  it("writes context and inputMode onto the project row, deriving idea/title from it", () => {
    const project = createProject(db, {
      inputMode: "context",
      context: "The full account of what actually happened, in detail.\nMore detail follows here.",
    });

    expect(project.inputMode).toBe("context");
    expect(project.context).toBe(
      "The full account of what actually happened, in detail.\nMore detail follows here.",
    );
    expect(project.idea).toBe("The full account of what actually happened, in detail.");
    expect(project.title).toBe("The full account of what actually happened, in detail.");
  });

  it("leaves context null and inputMode 'idea' for a plain idea project", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });

    expect(project.inputMode).toBe("idea");
    expect(project.context).toBeNull();
    expect(project.idea).toBe("a plumber became mayor by wits");
  });
});

describe("listAllJobs", () => {
  it("carries the owning project's idea/title alongside each job", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });

    const jobs = listAllJobs(db);
    const synopsisJob = jobs.find((j) => j.projectId === project.id && j.type === "synopsis");
    expect(synopsisJob?.project).toMatchObject({ id: project.id, idea: project.idea });
  });

  it("orders newest first across projects", () => {
    createProject(db, { idea: "the first of two ideas" });
    createProject(db, { idea: "the second of two ideas" });

    const jobs = listAllJobs(db);
    for (let i = 1; i < jobs.length; i++) {
      expect(jobs[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(jobs[i]!.createdAt.getTime());
    }
  });
});
