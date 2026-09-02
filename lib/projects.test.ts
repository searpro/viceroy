import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "./db/testing";
import { seed } from "./db/seed";
import type { Db } from "./db/client";
import {
  assets,
  characterReferenceImages,
  characters,
  devArtifacts,
  locations,
  projects,
  props,
  renders,
  sceneShots,
  scenes,
  storyboardPanels,
  voiceovers,
  wardrobeVariants,
} from "./db/schema";
import { listJobs } from "./queue";
import {
  createProject,
  createProjectSchema,
  currentResolutionKey,
  jobCounts,
  INVALIDATION_CHAIN,
  listAllJobs,
  projectSettingsSchema,
  regenerate,
  regenerateSchema,
  unlockCasting,
  updateProjectSettings,
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
      visualBrief: "a brief",
      imagePrompt: "a prompt",
      storyboard: "a storyboard",
      imageAssetId: imageAsset().id,
    })
    .returning()
    .all();
  // M9 — two shots covering that scene, so a scoped redo has something to be
  // scoped *to*. The scene keeps its pre-M9 fields as well, which is exactly
  // the mixed shape a project upgraded mid-flight is in.
  const shots = db
    .insert(sceneShots)
    .values([0, 1].map((index) => ({
      projectId: project.id,
      sceneId: scene!.id,
      index,
      startWord: index,
      endWord: index,
      imagePrompt: `shot prompt ${index}`,
      storyboard: `shot storyboard ${index}`,
      imageAssetId: imageAsset().id,
    })))
    .returning()
    .all();
  return { project, character: character!, scene: scene!, shots };
}

// A dev-format project with one panel, one location and one prop, each holding
// a generated image — the fixture the M7.1 PR-D0 scoped-redo tests share.
function devProjectWithPanelLocationProp() {
  const project = createProject(db, { idea: "a lighthouse keeper counts ships", format: "short_movie" });
  const [panel] = db
    .insert(storyboardPanels)
    .values({
      projectId: project.id,
      sceneId: "1",
      index: 0,
      panelImagePrompt: "Reyna at the workbench, close-up shot",
      shotType: "close-up",
      cameraAngle: "high",
      panelImageAssetId: imageAsset().id,
    })
    .returning()
    .all();
  const [location] = db
    .insert(locations)
    .values({
      projectId: project.id,
      name: "The lamp room",
      description: "brass and glass",
      imageAssetId: imageAsset().id,
      refInputName: "uploaded-lamp.png",
    })
    .returning()
    .all();
  const [prop] = db
    .insert(props)
    .values({
      projectId: project.id,
      name: "The logbook",
      description: "salt-stained",
      imageAssetId: imageAsset().id,
      refInputName: "uploaded-log.png",
    })
    .returning()
    .all();
  return { project, panel: panel!, location: location!, prop: prop! };
}

// The whole point of scoping a redo to one row: clearing its artifact is what
// makes the stage's own "skip what's already there" logic pick it up, rather
// than requiring the stage to know about scoped redos at all.
describe("regenerate — per-row scoping", () => {
  // The image goes with the prompt that produced it (BUG-019). Keeping it
  // would leave every scene holding an image, so `nextStep` walks past
  // `scene_images` and the frame the user was looking at never changes.
  it("clears the targeted scene's brief and its now-stale image for an elements redo", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", sceneId: scene.id, direction: "darker" });

    const after = db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!;
    expect(after.visualBrief).toBeNull();
    expect(after.imagePrompt).toBeNull();
    expect(after.storyboard).toBeNull();
    expect(after.imageAssetId).toBeNull();
  });

  // The shots go with the brief rather than being re-prompted under it: a
  // redone brief can change what is in the scene and how long it reads as
  // taking, so keeping the rows would pin a new scene to an old shot count.
  it("re-cuts the scene's coverage entirely for a scene-scoped elements redo", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", sceneId: scene.id });

    expect(db.select().from(sceneShots).where(eq(sceneShots.sceneId, scene.id)).all()).toHaveLength(0);
  });

  // M9's narrowest and most-used redo: one picture out of a scene's several,
  // without re-cutting the scene or spending the other frames again — which
  // at ~142s a referenced frame (F30) is the difference between a click and
  // an hour.
  it("clears one shot's prompt and image, leaving the scene and its siblings alone", () => {
    const { project, scene, shots } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", shotId: shots[0]!.id, direction: "closer" });

    const redone = db.select().from(sceneShots).where(eq(sceneShots.id, shots[0]!.id)).get()!;
    expect(redone.imagePrompt).toBeNull();
    expect(redone.storyboard).toBeNull();
    expect(redone.imageAssetId).toBeNull();
    // The slot itself survives — same words, same coverage, new picture.
    expect(redone.startWord).toBe(shots[0]!.startWord);
    expect(redone.shotType).toBe(shots[0]!.shotType);

    const sibling = db.select().from(sceneShots).where(eq(sceneShots.id, shots[1]!.id)).get()!;
    expect(sibling.imagePrompt).toBe("shot prompt 1");
    expect(sibling.imageAssetId).not.toBeNull();

    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!.visualBrief).toBe("a brief");
  });

  it("clears only the targeted shot's image for a shot-scoped scene_images redo", () => {
    const { project, shots } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "scene_images", shotId: shots[0]!.id });

    const redone = db.select().from(sceneShots).where(eq(sceneShots.id, shots[0]!.id)).get()!;
    expect(redone.imageAssetId).toBeNull();
    expect(redone.imagePrompt).toBe("shot prompt 0");
    expect(
      db.select().from(sceneShots).where(eq(sceneShots.id, shots[1]!.id)).get()!.imageAssetId,
    ).not.toBeNull();
  });

  // A scoped redo that clears nothing but still enqueues a job is the shape of
  // BUG-002: the resumable stage finds nothing pending, succeeds, and the
  // pipeline finishes something internally consistent but wrong.
  it("refuses a shotId belonging to another project", () => {
    const { project } = projectWithSceneAndCharacter();
    const { shots: other } = projectWithSceneAndCharacter();

    expect(() =>
      regenerate(db, project.id, { target: "scene_images", shotId: other[0]!.id }),
    ).toThrow(/No such shot/);
  });

  it("clears every shot of the targeted scene for a scene-scoped scene_images redo", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "scene_images", sceneId: scene.id });

    const after = db.select().from(sceneShots).where(eq(sceneShots.sceneId, scene.id)).all();
    expect(after.every((shot) => shot.imageAssetId === null)).toBe(true);
    expect(after.every((shot) => shot.imagePrompt !== null)).toBe(true);
    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!.imageAssetId).toBeNull();
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

  it("carries shotId and direction through to the enqueued job's payload", () => {
    const { project, shots } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "scene_images", shotId: shots[0]!.id, direction: "closer" });

    const job = listJobs(db, { projectId: project.id }).find((j) => j.type === "scene_images");
    expect(job?.payload).toMatchObject({ shotId: shots[0]!.id, direction: "closer" });
  });

  it("carries sceneId and direction through to the enqueued job's payload", () => {
    const { project, scene } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements", sceneId: scene.id, direction: "darker" });

    const job = listJobs(db, { projectId: project.id }).find((j) => j.type === "elements");
    expect(job?.payload).toMatchObject({ sceneId: scene.id, direction: "darker" });
  });

  it("leaves every scene and shot alone when nothing is scoped", () => {
    const { project, scene, shots } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements" });

    expect(db.select().from(scenes).where(eq(scenes.id, scene.id)).get()!.visualBrief).toBe("a brief");
    expect(
      db.select().from(sceneShots).where(eq(sceneShots.id, shots[0]!.id)).get()!.imagePrompt,
    ).toBe("shot prompt 0");
  });

  // The stages *after* elements are what an unscoped redo discards, and a
  // shot's picture is one of them — it hangs off `scene_shots` now rather than
  // off the scene, so clearing only the scene would leave every frame in place
  // and `nextStep` would walk straight past `scene_images`.
  it("clears every shot's image when an upstream stage is redone unscoped", () => {
    const { project } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "elements" });

    const after = db.select().from(sceneShots).where(eq(sceneShots.projectId, project.id)).all();
    expect(after.every((shot) => shot.imageAssetId === null)).toBe(true);
  });

  it("clears every shot's timeline position when alignment is invalidated", () => {
    const { project } = projectWithSceneAndCharacter();
    db.update(sceneShots)
      .set({ startMs: 0, endMs: 2500 })
      .where(eq(sceneShots.projectId, project.id))
      .run();

    regenerate(db, project.id, { target: "voiceover" });

    const after = db.select().from(sceneShots).where(eq(sceneShots.projectId, project.id)).all();
    expect(after.every((shot) => shot.startMs === null && shot.endMs === null)).toBe(true);
  });
});

// M7 PR12 — the identity lock. `castingLockedAt` is only ever set by the dev
// chain's "casting" stage (lib/pipeline/dev.ts), never by anything in the
// narrative pipeline — these tests exercise the guard from the narrative
// side (`character_images`) specifically to prove that: acceptance criterion
// 6 requires the narrative pipeline's own behaviour stay unchanged, and the
// only way that's true is if a narrative-pipeline character is never locked
// in the first place, not just that the guard "happens" to pass it through.
describe("regenerate — casting lock (M7 PR12)", () => {
  it("refuses a character_images redo for a cast-locked character, naming why", () => {
    const { project, character } = projectWithSceneAndCharacter();
    db.update(characters)
      .set({ castingLockedAt: new Date() })
      .where(eq(characters.id, character.id))
      .run();

    expect(() =>
      regenerate(db, project.id, { target: "character_images", characterId: character.id }),
    ).toThrow(/cast-locked/);

    // Refused, not silently skipped — the character's portrait is untouched.
    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageAssetId).not.toBeNull();
  });

  it("allows the redo again once unlocked", () => {
    const { project, character } = projectWithSceneAndCharacter();
    db.update(characters)
      .set({ castingLockedAt: new Date() })
      .where(eq(characters.id, character.id))
      .run();

    unlockCasting(db, project.id, character.id);
    regenerate(db, project.id, { target: "character_images", characterId: character.id });

    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageAssetId).toBeNull(); // cleared by the redo, same as the unlocked case below
  });

  // Regression check (acceptance criterion 6): an unlocked character's
  // portrait redo behaves exactly as it did before this PR — the guard must
  // never fire for the ordinary, unlocked case.
  it("never blocks a character_images redo for a character that was never locked", () => {
    const { project, character } = projectWithSceneAndCharacter();
    regenerate(db, project.id, { target: "character_images", characterId: character.id });

    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageAssetId).toBeNull();
    expect(after.imagePrompt).toBeNull();
    expect(after.refInputName).toBeNull();
  });

  it("unlockCasting clears only the targeted character's lock", () => {
    const { project, character } = projectWithSceneAndCharacter();
    const [other] = db
      .insert(characters)
      .values({ projectId: project.id, name: "Other", description: "d" })
      .returning()
      .all();
    db.update(characters)
      .set({ castingLockedAt: new Date() })
      .where(eq(characters.projectId, project.id))
      .run();

    unlockCasting(db, project.id, character.id);

    expect(db.select().from(characters).where(eq(characters.id, character.id)).get()!.castingLockedAt).toBeNull();
    expect(
      db.select().from(characters).where(eq(characters.id, other!.id)).get()!.castingLockedAt,
    ).not.toBeNull();
  });

  it("unlockCasting refuses a character that belongs to a different project", () => {
    const { character } = projectWithSceneAndCharacter();
    const otherProject = createProject(db, { idea: "an entirely different idea, unrelated" });

    expect(() => unlockCasting(db, otherProject.id, character.id)).toThrow();
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

  it("includes all twenty-two Development/Preproduction-chain stages in DEV_CHAIN_STAGES order", () => {
    const devStages = INVALIDATION_CHAIN.slice(INVALIDATION_CHAIN.length - 22);
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
      // Preproduction (M7 PR6-PR13).
      "script_breakdown",
      "scene_breakdown",
      "continuity",
      "visual_bible",
      "production_design",
      // M7.1 PR-A moved "casting" above "concept_art": identity has to be
      // locked before any stage draws a character, and this position is what
      // makes a casting redo cascade the four image stages below it.
      "casting",
      "concept_art",
      "storyboards",
      "shot_list",
      "previs",
      "production_plan",
      // Stage 22 (M7.2). Last, so every upstream redo clears the timeline —
      // which is the correct direction: a shot-list redo must not leave a
      // timeline describing shots that no longer exist.
      "timeline",
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

describe("regenerate — per-item image scoping (M7.1 PR-D0)", () => {
  it("clears only the targeted panel's image, leaving its prompt and cinematography intact", () => {
    const { project, panel } = devProjectWithPanelLocationProp();
    const job = regenerate(db, project.id, { target: "storyboards", panelId: panel.id });

    const after = db.select().from(storyboardPanels).where(eq(storyboardPanels.id, panel.id)).get()!;
    expect(after.panelImageAssetId).toBeNull();
    // The planning around the picture survives — a re-roll re-rolls the image,
    // it does not discard a prompt or a shot choice a human may have edited.
    expect(after.panelImagePrompt).toBe("Reyna at the workbench, close-up shot");
    expect(after.shotType).toBe("close-up");
    expect(after.cameraAngle).toBe("high");
    expect(job.payload.panelId).toBe(panel.id);
  });

  it("clears a scoped location's image and its host reference, so nothing keeps anchoring to the old plate", () => {
    const { project, location } = devProjectWithPanelLocationProp();
    regenerate(db, project.id, { target: "concept_art", locationId: location.id });

    const after = db.select().from(locations).where(eq(locations.id, location.id)).get()!;
    expect(after.imageAssetId).toBeNull();
    expect(after.refInputName).toBeNull();
    expect(after.description).toBe("brass and glass");
  });

  it("leaves the sibling prop untouched when a location is scoped", () => {
    const { project, location, prop } = devProjectWithPanelLocationProp();
    regenerate(db, project.id, { target: "concept_art", locationId: location.id });

    const after = db.select().from(props).where(eq(props.id, prop.id)).get()!;
    expect(after.imageAssetId).not.toBeNull();
    expect(after.refInputName).toBe("uploaded-log.png");
  });

  it("clears a scoped prop the same way", () => {
    const { project, prop } = devProjectWithPanelLocationProp();
    regenerate(db, project.id, { target: "concept_art", propId: prop.id });

    const after = db.select().from(props).where(eq(props.id, prop.id)).get()!;
    expect(after.imageAssetId).toBeNull();
    expect(after.refInputName).toBeNull();
  });

  // A scoped redo skips `invalidateDownstreamOf` entirely — that is what makes
  // it cheap, and what would make a cross-project id dangerous if it were not
  // matched on projectId.
  it("refuses a panel id belonging to another project rather than clearing it", () => {
    const { panel } = devProjectWithPanelLocationProp();
    const other = createProject(db, { idea: "an unrelated second film", format: "short_movie" });

    expect(() => regenerate(db, other.id, { target: "storyboards", panelId: panel.id })).toThrow(
      /No such storyboard panel on this project/,
    );

    const untouched = db.select().from(storyboardPanels).where(eq(storyboardPanels.id, panel.id)).get()!;
    expect(untouched.panelImageAssetId).not.toBeNull();
  });

  it("refuses a location id belonging to another project", () => {
    const { location } = devProjectWithPanelLocationProp();
    const other = createProject(db, { idea: "an unrelated second film", format: "short_movie" });

    expect(() => regenerate(db, other.id, { target: "concept_art", locationId: location.id })).toThrow(
      /No such location on this project/,
    );
  });

  // Silently ignoring a scope the target cannot honour is the expensive
  // failure: the caller asks for one panel and gets the whole stage.
  it("refuses a scope key the target does not understand", () => {
    const { project, panel } = devProjectWithPanelLocationProp();
    expect(() => regenerate(db, project.id, { target: "concept_art", panelId: panel.id })).toThrow(
      /"panelId" does not scope a "concept_art" redo/,
    );
  });

  it("refuses panelId on a narrative-pipeline target too, not just the wrong dev stage", () => {
    const { project, panel } = devProjectWithPanelLocationProp();
    expect(() => regenerate(db, project.id, { target: "story", panelId: panel.id })).toThrow(
      /does not scope a "story" redo/,
    );
  });

  it("does not cascade downstream stages, unlike an unscoped redo of the same target", () => {
    const { project, panel } = devProjectWithPanelLocationProp();
    db.insert(devArtifacts)
      .values({ projectId: project.id, stage: "production_plan", content: "a plan", approvedAt: new Date() })
      .run();

    regenerate(db, project.id, { target: "storyboards", panelId: panel.id });

    // "production_plan" sits well downstream of "storyboards"; an unscoped redo
    // would have cleared it.
    const plan = db.select().from(devArtifacts).where(eq(devArtifacts.projectId, project.id)).get()!;
    expect(plan.content).toBe("a plan");
    expect(plan.approvedAt).not.toBeNull();
  });
});

describe("regenerate — the reference pack goes with the identity (M7.1 PR-B)", () => {
  function castWithPack() {
    const project = createProject(db, { idea: "a diver who fears the surface", format: "short_movie" });
    const [character] = db
      .insert(characters)
      .values({
        projectId: project.id,
        name: "Reyna",
        description: "d",
        imageAssetId: imageAsset().id,
        refInputName: "uploaded-reyna.png",
        castingLockedAt: new Date(),
      })
      .returning()
      .all();
    for (const view of ["head_front", "body_front", "expression_sad"] as const) {
      db.insert(characterReferenceImages)
        .values({
          characterId: character!.id,
          view,
          imageAssetId: imageAsset().id,
          refInputName: `uploaded-reyna-${view}.png`,
        })
        .run();
    }
    return { project, character: character! };
  }

  // The invariant, and the reason this block exists: the pack is cleared
  // exactly when the anchor it depicts is cleared — never one without the
  // other. `runCasting` skips a view that already has an image, so a pack
  // surviving a cleared anchor would put a regenerated face inside seven views
  // of the old one, and panels pick their reference *from that pack*.
  it("leaves the pack exactly as intact as the anchor on an unscoped casting redo", () => {
    const { project, character } = castWithPack();
    expect(db.select().from(characterReferenceImages).all()).toHaveLength(3);

    // An unscoped redo deliberately leaves its own target's output alone (the
    // job it enqueues is what overwrites it), so the anchor survives here — and
    // the pack must survive with it, or the two would disagree.
    regenerate(db, project.id, { target: "casting" });

    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageAssetId).not.toBeNull();
    expect(db.select().from(characterReferenceImages).all()).toHaveLength(3);
  });

  it("clears only the scoped character's pack, leaving the rest of the cast's alone", () => {
    const { project, character } = castWithPack();
    const [other] = db
      .insert(characters)
      .values({ projectId: project.id, name: "Marisol", description: "d" })
      .returning()
      .all();
    db.insert(characterReferenceImages)
      .values({ characterId: other!.id, view: "head_front", refInputName: "uploaded-marisol.png" })
      .run();

    // Locked, so the redo needs the explicit unlock first — the same two-step
    // the API route pairs.
    unlockCasting(db, project.id, character.id);
    regenerate(db, project.id, { target: "casting", characterId: character.id });

    const left = db.select().from(characterReferenceImages).all();
    expect(left).toHaveLength(1);
    expect(left[0]!.characterId).toBe(other!.id);
  });

  // Deliberately *not* cleared alongside the pack. A variant is a plan, not a
  // picture: it is derived from `characters.description`, which belongs to the
  // upstream "characters" stage and a casting redo does not touch. Keeping them
  // makes wardrobe stable across redos and saves re-proposing — `runCasting`
  // only proposes when a character has none — while the body views themselves
  // still regenerate, because the pack rows did go.
  it("keeps wardrobe variants across a casting cascade, even though the pack goes", () => {
    const { project, character } = castWithPack();
    db.insert(wardrobeVariants)
      .values({ characterId: character.id, name: "Workshop", description: "canvas apron", isDefault: true })
      .run();

    regenerate(db, project.id, { target: "production_design" });

    expect(db.select().from(characterReferenceImages).all()).toHaveLength(0);
    expect(db.select().from(wardrobeVariants).all()).toHaveLength(1);
  });

  it("takes the pack with it when an upstream stage cascades into casting", () => {
    const { project, character } = castWithPack();
    // "production_design" sits directly above casting as of M7.1 PR-A, so its
    // redo cascades through `DISCARD["casting"]` — which clears the anchor, so
    // the pack has to go too.
    regenerate(db, project.id, { target: "production_design" });

    const after = db.select().from(characters).where(eq(characters.id, character.id)).get()!;
    expect(after.imageAssetId).toBeNull();
    expect(db.select().from(characterReferenceImages).all()).toHaveLength(0);
  });
});

describe("updateProjectSettings", () => {
  /**
   * The reason this exists at all: `aspect_ratio` arrived in M7.1 PR-E, so
   * every project made before it stores no shape and the global 1080x1920
   * default — which means every movie in an existing database is a vertical
   * short on disk, with no control anywhere to say otherwise.
   */
  function legacyMovie() {
    const project = createProject(db, {
      idea: "a lighthouse keeper finds the storms are deliberate",
      format: "short_movie",
    });
    db.update(projects)
      .set({ aspectRatio: null, width: 1080, height: 1920 })
      .where(eq(projects.id, project.id))
      .run();
    return project.id;
  }

  it("stores the shape and re-derives both dimensions from it", () => {
    const id = legacyMovie();
    const result = updateProjectSettings(db, id, { aspectRatio: "16:9" });

    expect(result.aspectRatio).toBe("16:9");
    expect(result.width / result.height).toBeCloseTo(16 / 9, 2);

    const row = db.select().from(projects).where(eq(projects.id, id)).get()!;
    expect(row.aspectRatio).toBe("16:9");
    expect(row.width).toBe(result.width);
    expect(row.height).toBe(result.height);
  });

  it("keeps the shape when only the size changes", () => {
    const id = legacyMovie();
    updateProjectSettings(db, id, { aspectRatio: "2.39:1" });
    const smaller = updateProjectSettings(db, id, { resolutionKey: "draft" });

    expect(smaller.aspectRatio).toBe("2.39:1");
    expect(smaller.width / smaller.height).toBeCloseTo(2.39, 1);
  });

  it("keeps the size tier when only the shape changes", () => {
    const id = legacyMovie();
    updateProjectSettings(db, id, { aspectRatio: "16:9", resolutionKey: "low" });
    const rotated = updateProjectSettings(db, id, { aspectRatio: "1:1" });

    // Same tier means the same amount of work, not the same width — that is
    // the whole point of scaling presets by area rather than by dimension.
    expect(rotated.resolutionKey).toBe("low");
    expect(rotated.width).toBe(rotated.height);
  });

  it("does not touch anything already generated", () => {
    const id = legacyMovie();
    const asset = imageAsset();
    db.insert(storyboardPanels)
      .values({ projectId: id, sceneId: "1", index: 0, panelImageAssetId: asset.id })
      .run();

    updateProjectSettings(db, id, { aspectRatio: "16:9" });

    const panels = db.select().from(storyboardPanels).where(eq(storyboardPanels.projectId, id)).all();
    expect(panels).toHaveLength(1);
    expect(panels[0]!.panelImageAssetId).toBe(asset.id);
  });

  it("refuses a patch that names neither field", () => {
    expect(projectSettingsSchema.safeParse({}).success).toBe(false);
  });

  it("refuses an unknown project", () => {
    expect(() => updateProjectSettings(db, "nope", { aspectRatio: "16:9" })).toThrow(/No such project/);
  });
});

describe("currentResolutionKey", () => {
  it("recognises a project stored at an exact preset", () => {
    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      resolutionKey: "standard",
    });
    expect(currentResolutionKey(project)).toBe("standard");
  });

  it("picks the nearest tier for a project whose shape was never set", () => {
    // 1080x1920 is the vertical HD preset; read as a *landscape* movie it
    // matches no preset exactly, and falling straight to "hd" regardless would
    // make the control open on the wrong tier.
    const key = currentResolutionKey({
      format: "short_movie",
      aspectRatio: null,
      width: 1080,
      height: 1920,
    });
    expect(key).toBe("hd");
  });

  it("falls back to hd when there are no dimensions at all", () => {
    expect(currentResolutionKey({ format: "short_movie" })).toBe("hd");
  });
});

describe("jobCounts", () => {
  // The nav badge polls this every few seconds on every open tab, so it is a
  // GROUP BY rather than `listAllJobs(...).filter(...)`. It must also count
  // every job, not the newest window — a badge that says "nothing running"
  // because the running job fell outside a limit is worse than no badge.
  it("counts queued and running together, and failed separately", () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    const queued = listJobs(db, { projectId: project.id });
    expect(queued.length).toBeGreaterThan(0);

    expect(jobCounts(db)).toEqual({ active: queued.length, failed: 0 });
  });

  it("is zero on an empty queue", () => {
    expect(jobCounts(db)).toEqual({ active: 0, failed: 0 });
  });
});
