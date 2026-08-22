import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import { assets, characters, devArtifacts, projects, renders, scenes, voiceovers } from "./db/schema";
import { listJobs } from "./queue";
import {
  createProject,
  createProjectSchema,
  INVALIDATION_CHAIN,
  listAllJobs,
  regenerate,
  regenerateSchema,
} from "./projects";

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
  // The image goes with the prompt that produced it (BUG-019). Keeping it
  // would leave every scene holding an image, so `nextStep` walks past
  // `scene_images` and the frame the user was looking at never changes.
  it("clears the targeted scene's prompt and its now-stale image for an elements redo", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", sceneId: scene.id, direction: "darker" });

    const after = db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!;
    expect(after.imagePrompt).toBeNull();
    expect(after.storyboard).toBeNull();
    expect(after.imageAssetId).toBeNull();
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

  // VIC-002: a redo on a previously-uploaded character is a "revert to
  // generated" — it must flip imageSource back too, or the character stays
  // (incorrectly) excluded from character_images' pending filter.
  it("resets imageSource to generated when redoing a previously-uploaded character", () => {
    const { project, character } = projectWithSceneAndCharacter();
    db.update(characters).set({ imageSource: "uploaded" }).where(eq(characters.id, character.id)).run();

    regenerate(db, project.id, { target: "character_images", characterId: character.id });

    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageSource).toBe("generated");
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

// An unscoped redo invalidates everything derived from the stage's output.
// The failure this prevents is silent: a resumable stage skips artifacts the
// redo left behind, and the pipeline finishes a video assembled from two
// different stories with nothing erroring, because each half is self-consistent
// (BUG-002, BUG-015, BUG-016).
describe("regenerate — downstream invalidation", () => {
  it("removes existing scenes so elements re-groups them from the new story", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "story", direction: "make it colder" });

    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()).toBeUndefined();
  });

  // BUG-016: `runElements` skips extraction whenever the cast is non-empty, so
  // a surviving character is pasted into every new scene prompt and used as a
  // reference image for someone who may no longer be in the story.
  it("removes the cast on a story redo so elements re-extracts it", () => {
    const { project, character } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "story" });

    expect(db.select().from(characters).where(eq(characters.id, character.id)).get()).toBeUndefined();
  });

  // BUG-015: the worst case. A synopsis redo used to clear nothing, so the new
  // story was written, the old scenes survived, and the voiceover was spoken
  // from the discarded story's text.
  it("clears the story and its scenes on a synopsis redo", () => {
    const { project, scene, character } = projectWithSceneAndCharacter();
    db.update(projects).set({ story: "the old story" }).where(eq(projects.id, project.id)).run();

    regenerate(db, project.id, { target: "synopsis" });

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.story).toBeNull();
    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()).toBeUndefined();
    expect(db.select().from(characters).where(eq(characters.id, character.id)).get()).toBeUndefined();
  });

  it("leaves the redone stage's own output alone — the stage overwrites it", () => {
    const { project } = projectWithSceneAndCharacter();
    db.update(projects).set({ synopsis: "the current synopsis" }).where(eq(projects.id, project.id)).run();

    regenerate(db, project.id, { target: "synopsis" });

    expect(db.select().from(projects).where(eq(projects.id, project.id)).get()!.synopsis).toBe(
      "the current synopsis",
    );
  });

  it("does not reach back past the redone stage", () => {
    const { project } = projectWithSceneAndCharacter();
    db.update(projects)
      .set({ synopsis: "kept", story: "kept too" })
      .where(eq(projects.id, project.id))
      .run();

    regenerate(db, project.id, { target: "scene_images" });

    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.synopsis).toBe("kept");
    expect(after.story).toBe("kept too");
  });

  // A redirected delivery lives on the voiceover row, and `runVoiceover` reads
  // it back to prefer the user's cues over the voice style's default.
  it("keeps ttsInstruct when invalidating a voiceover upstream", () => {
    const { project } = projectWithSceneAndCharacter();
    db.insert(voiceovers)
      .values({
        projectId: project.id,
        script: "One.",
        ttsInstruct: "slower, less breathy",
        audioAssetId: imageAsset().id,
        durationMs: 1000,
      })
      .run();

    regenerate(db, project.id, { target: "story" });

    const after = db.select().from(voiceovers).where(eq(voiceovers.projectId, project.id)).get()!;
    expect(after.ttsInstruct).toBe("slower, less breathy");
    expect(after.audioAssetId).toBeNull();
  });

  // A scoped redo is a request to redraw one frame, not to rebuild the project
  // from that point down.
  it("does not cascade when the redo is scoped to one row", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    db.insert(renders)
      .values({ projectId: project.id, width: 1080, height: 1920, captionStyle: {}, status: "ready" })
      .run();

    regenerate(db, project.id, { target: "scene_images", sceneId: scene.id });

    expect(db.select().from(renders).where(eq(renders.projectId, project.id)).all()).toHaveLength(1);
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

// M7 PR1: a project now says what kind of thing it's making.
describe("createProjectSchema — format", () => {
  it("defaults format to 'short_video_narrative' when omitted", () => {
    const result = createProjectSchema.safeParse({ idea: "a plumber became mayor by wits" });
    expect(result.success).toBe(true);
    expect(result.success && result.data.format).toBe("short_video_narrative");
  });

  it("accepts an explicit dev-chain format", () => {
    const result = createProjectSchema.safeParse({
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.format).toBe("short_movie");
  });

  it("rejects a format outside the six-value enum", () => {
    const result = createProjectSchema.safeParse({
      idea: "a plumber became mayor by wits",
      format: "feature_length_epic",
    });
    expect(result.success).toBe(false);
  });
});

describe("createProject — format", () => {
  // Acceptance criterion 2: the most important one. A project created with no
  // `format` field, or an explicit `short_video_narrative`, must be
  // byte-for-byte today's existing behaviour — the same synopsis job queued,
  // same as every test above this one already assumes.
  it("writes 'short_video_narrative' and queues a synopsis job when format is omitted", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });

    expect(project.format).toBe("short_video_narrative");
    expect(listJobs(db, { projectId: project.id }).some((j) => j.type === "synopsis")).toBe(true);
  });

  it("writes the given format and queues nothing for a dev-chain format", () => {
    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });

    expect(project.format).toBe("short_movie");
    expect(listJobs(db, { projectId: project.id })).toHaveLength(0);
  });
});

// Acceptance criterion 3.
describe("regenerate — dev-artifact target validation", () => {
  it("rejects a dev-artifact target on a short_video_narrative project", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });

    expect(() => regenerate(db, project.id, { target: "concept" })).toThrow(
      /not valid for a short_video_narrative project/,
    );
  });

  it("accepts a dev-artifact target on a project running the Development chain", () => {
    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });

    expect(() => regenerate(db, project.id, { target: "concept" })).not.toThrow();
    const job = listJobs(db, { projectId: project.id }).find((j) => j.type === "concept");
    expect(job).toBeDefined();
  });

  it("clears approvedAt/content but keeps directionHistory when a dev stage is redone", () => {
    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });
    db.insert(devArtifacts)
      .values({
        projectId: project.id,
        stage: "concept",
        content: "an idea about a plumber",
        approvedAt: new Date(),
        directionHistory: ["make it funnier"],
      })
      .run();

    regenerate(db, project.id, { target: "logline", direction: "sharpen the hook" });

    const after = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()[0]!;
    // "concept" precedes "logline" in DEV_ARTIFACT_STAGES/INVALIDATION_CHAIN,
    // so redoing "logline" must leave "concept"'s own output alone — the same
    // "does not reach back past the redone stage" rule the narrative chain
    // tests above already cover.
    expect(after.approvedAt).not.toBeNull();
    expect(after.content).toBe("an idea about a plumber");
  });

  it("clears a downstream dev stage's approvedAt/content while keeping directionHistory", () => {
    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });
    db.insert(devArtifacts)
      .values({
        projectId: project.id,
        stage: "logline",
        content: "a plumber runs for mayor",
        approvedAt: new Date(),
        directionHistory: ["make it funnier"],
      })
      .run();

    regenerate(db, project.id, { target: "concept", direction: "start over" });

    const after = db
      .select()
      .from(devArtifacts)
      .where(eq(devArtifacts.projectId, project.id))
      .all()[0]!;
    expect(after.approvedAt).toBeNull();
    expect(after.content).toBe("");
    expect(after.directionHistory).toEqual(["make it funnier"]);
  });
});

// Acceptance criterion 4: adding a stage to `regenerateSchema` without an
// `INVALIDATION_CHAIN` entry is a compile error (ADR 0003) — `DISCARD`'s type
// forces every `INVALIDATION_CHAIN` entry to have a handler, and every value
// passed to `invalidateDownstreamOf` has to be assignable to that same union.
// This test can't observe a compile error at runtime, so it pins the
// structural invariant that makes it one: the two lists name exactly the
// same set of stages, dev-artifact stages included.
describe("regenerateSchema / INVALIDATION_CHAIN — kept in sync (ADR 0003)", () => {
  it("has one INVALIDATION_CHAIN entry per regenerateSchema target, and vice versa", () => {
    const targets = [...regenerateSchema.shape.target.options].sort();
    const chain = [...INVALIDATION_CHAIN].sort();
    expect(targets).toEqual(chain);
  });

  it("includes all sixteen Development/Preproduction-chain stages in DEV_CHAIN_STAGES order", () => {
    const devStages = INVALIDATION_CHAIN.slice(INVALIDATION_CHAIN.length - 16);
    expect(devStages).toEqual([
      "concept",
      "logline",
      "characters",
      "world_building",
      "story_structure",
      "beat_sheet",
      "treatment",
      "screenplay",
      "screenplay_revision",
      "story_bible",
      // Preproduction (M7 PR6-PR9).
      "script_breakdown",
      "scene_breakdown",
      "continuity",
      "visual_bible",
      "production_design",
      "concept_art",
    ]);
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
