import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import {
  assets,
  characters,
  continuityFacts,
  devArtifacts,
  evaluations,
  projects,
  renders,
  sceneShots,
  scenes,
  shotListItems,
  storyboardPanels,
  subtitleCues,
  timelines,
  timelineSegments,
  voiceovers,
  worldBuilding,
} from "../db/schema";
import { claim, enqueue, listJobs, succeed } from "../queue";
import { createProject } from "../projects";
import { advance, isStalled, nextStep } from "./chain";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

function newProject() {
  const project = createProject(db, { idea: "a plumber became mayor by wits" });
  // createProject queues the first synopsis job; clear it so each test starts
  // from a quiet queue.
  for (const job of listJobs(db, { projectId: project.id })) {
    claim(db);
    succeed(db, job.id);
  }
  return project;
}

function imageAsset() {
  return db
    .insert(assets)
    .values({ kind: "image", path: "/tmp/i.png", mimeType: "image/png", bytes: 1 })
    .returning()
    .all()[0]!;
}

/** Walk a project forward to just before the named step. */
function buildUpTo(projectId: string, upTo: string) {
  const order = [
    "synopsis",
    "story",
    "story_eval",
    "elements",
    "character_images",
    "scene_images",
    "voiceover",
    "subtitle_align",
    "render",
  ];
  // "done" means everything, so it sits past the end of the list.
  const stop = upTo === "done" ? order.length : order.indexOf(upTo);
  const has = (name: string) => order.indexOf(name) < stop;

  if (has("synopsis")) {
    db.update(projects).set({ synopsis: "S." }).where(eq(projects.id, projectId)).run();
  }
  if (has("story")) {
    db.update(projects).set({ story: "One. Two." }).where(eq(projects.id, projectId)).run();
  }
  if (has("story_eval")) {
    db.insert(evaluations)
      .values({
        projectId,
        iteration: 1,
        verdict: "pass",
        dimensions: {},
        issues: [],
        model: "test",
      })
      .run();
  }
  if (has("elements")) {
    db.insert(characters)
      .values({ projectId, name: "Hal", description: "d", appearanceTag: "a man" })
      .run();
    const scene = db
      .insert(scenes)
      .values({
        projectId,
        index: 0,
        description: "s",
        voiceoverScript: "One. Two.",
        visualBrief: "a brief",
      })
      .returning()
      .all()[0]!;
    // M9: a scene is a span of narration covered by shots, and it is the shots
    // that carry the prompt, the picture and the timeline position.
    db.insert(sceneShots)
      .values({
        projectId,
        sceneId: scene.id,
        index: 0,
        startWord: 0,
        endWord: 1,
        imagePrompt: "a prompt",
      })
      .run();
  }
  if (has("character_images")) {
    db.update(characters)
      .set({ imageAssetId: imageAsset().id })
      .where(eq(characters.projectId, projectId))
      .run();
  }
  if (has("scene_images")) {
    db.update(sceneShots)
      .set({ imageAssetId: imageAsset().id })
      .where(eq(sceneShots.projectId, projectId))
      .run();
  }
  if (has("voiceover")) {
    const audio = db
      .insert(assets)
      .values({ kind: "audio", path: "/tmp/n.wav", mimeType: "audio/wav", bytes: 1 })
      .returning()
      .all()[0]!;
    db.insert(voiceovers)
      .values({
        projectId,
        script: "One. Two.",
        ttsInstruct: "x",
        audioAssetId: audio.id,
        durationMs: 1000,
      })
      .run();
  }
  if (has("subtitle_align")) {
    const scene = db.select().from(scenes).where(eq(scenes.projectId, projectId)).get()!;
    db.update(scenes).set({ startMs: 0, endMs: 1000 }).where(eq(scenes.id, scene.id)).run();
    db.update(sceneShots)
      .set({ startMs: 0, endMs: 1000 })
      .where(eq(sceneShots.projectId, projectId))
      .run();
    db.insert(subtitleCues)
      .values({ projectId, sceneId: scene.id, index: 0, text: "One.", startMs: 0, endMs: 1000 })
      .run();
  }
  if (has("render")) {
    db.insert(renders)
      .values({ projectId, width: 1080, height: 1920, captionStyle: {}, status: "ready" })
      .run();
  }
}

describe("nextStep", () => {
  it.each([
    ["synopsis", "synopsis"],
    ["story", "story"],
    ["story_eval", "story_eval"],
    ["elements", "elements"],
    ["character_images", "character_images"],
    ["scene_images", "scene_images"],
    ["voiceover", "voiceover"],
    ["subtitle_align", "subtitle_align"],
    ["render", "render"],
  ])("asks for %s when that is the outstanding work", (upTo, expected) => {
    const project = newProject();
    buildUpTo(project.id, upTo);
    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: expected });
  });

  it("reports complete once a render is ready", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    expect(nextStep(db, project.id).kind).toBe("complete");
  });

  // The whole reason for deriving from artifacts: work that vanished has to be
  // noticed, whatever the stage column claims.
  it("goes back for an image that was deleted, ignoring the stage label", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    db.update(sceneShots).set({ imageAssetId: null }).where(eq(sceneShots.projectId, project.id)).run();
    db.update(projects).set({ stage: "complete" }).where(eq(projects.id, project.id)).run();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "scene_images" });
  });

  it("re-extracts when a shot lost its image prompt", () => {
    const project = newProject();
    buildUpTo(project.id, "character_images");
    db.update(sceneShots).set({ imagePrompt: null }).where(eq(sceneShots.projectId, project.id)).run();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "elements" });
  });

  it("re-extracts when a scene has no shots covering it", () => {
    const project = newProject();
    buildUpTo(project.id, "character_images");
    db.delete(sceneShots).where(eq(sceneShots.projectId, project.id)).run();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "elements" });
  });

  // A project finished before M9 has a scene-level prompt, still and timing,
  // and no shots at all. Nothing about it should be re-derived: the shots
  // cannot be recovered without discarding the pictures it already has.
  it("leaves a pre-M9 project alone rather than re-covering it", () => {
    const project = newProject();
    // Everything but the render, so the project can be reshaped into its
    // pre-M9 form before the video is recorded — mutating a scene after the
    // render row exists would trip the "older than its inputs" check instead.
    buildUpTo(project.id, "render");
    const scene = db.select().from(scenes).where(eq(scenes.projectId, project.id)).get()!;
    db.delete(sceneShots).where(eq(sceneShots.projectId, project.id)).run();
    db.update(scenes)
      .set({ visualBrief: null, imagePrompt: "a prompt", imageAssetId: imageAsset().id })
      .where(eq(scenes.id, scene.id))
      .run();
    db.insert(renders)
      .values({ projectId: project.id, width: 1080, height: 1920, captionStyle: {}, status: "ready" })
      .run();

    expect(nextStep(db, project.id).kind).toBe("complete");
  });

  // The rule is narrow on purpose: a pre-M9 project is preserved exactly as
  // long as it is intact. The moment it needs image work done again there is
  // nothing left to preserve, so it is upgraded to M9 coverage rather than
  // redrawn as a single still.
  it("upgrades a pre-M9 project to shots once its still goes missing", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    const scene = db.select().from(scenes).where(eq(scenes.projectId, project.id)).get()!;
    db.delete(sceneShots).where(eq(sceneShots.projectId, project.id)).run();
    db.update(scenes)
      .set({ visualBrief: null, imagePrompt: "a prompt", imageAssetId: null })
      .where(eq(scenes.id, scene.id))
      .run();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "elements" });
  });

  it("does not demand portraits for a story with no cast", () => {
    const project = newProject();
    buildUpTo(project.id, "character_images");
    db.delete(characters).where(eq(characters.projectId, project.id)).run();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "scene_images" });
  });

  // BUG-017: every other artifact above answers "does this exist"; a render is
  // the one whose existence does not imply it is current. Manual mode reaches
  // this line by clicking Continue, where nothing else re-enqueues a render —
  // so without the recency check the user is handed back the previous video.
  it("re-renders when a scene was regenerated after the finished video", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    expect(nextStep(db, project.id).kind).toBe("complete");

    db.update(scenes)
      .set({ imageAssetId: imageAsset().id, updatedAt: new Date(Date.now() + 60_000) })
      .where(eq(scenes.projectId, project.id))
      .run();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "render" });
  });

  it("stays complete when the render is newer than everything it was built from", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    db.update(renders)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(renders.projectId, project.id))
      .run();

    expect(nextStep(db, project.id).kind).toBe("complete");
  });

  it("throws for an unknown project", () => {
    expect(() => nextStep(db, "nope")).toThrow(/No such project/);
  });
});

describe("isStalled", () => {
  // The bug two real projects hit: every job succeeded, nothing queued, not
  // parked for review — so no worker would touch it and no screen asked.
  it("flags a project with outstanding work and nothing queued", () => {
    const project = newProject();
    buildUpTo(project.id, "voiceover");
    expect(isStalled(db, project.id)).toBe(true);
  });

  it("does not flag one that is waiting on a job", () => {
    const project = newProject();
    buildUpTo(project.id, "voiceover");
    enqueue(db, { type: "voiceover", projectId: project.id });
    expect(isStalled(db, project.id)).toBe(false);
  });

  it("does not flag one parked for review", () => {
    const project = newProject();
    buildUpTo(project.id, "voiceover");
    db.update(projects).set({ awaitingReview: true }).where(eq(projects.id, project.id)).run();
    expect(isStalled(db, project.id)).toBe(false);
  });

  it("does not flag a finished project", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    expect(isStalled(db, project.id)).toBe(false);
  });
});

describe("advance", () => {
  it("queues the outstanding work and clears the review flag", () => {
    const project = newProject();
    buildUpTo(project.id, "voiceover");
    db.update(projects)
      .set({ awaitingReview: true, failureReason: "something" })
      .where(eq(projects.id, project.id))
      .run();

    const step = advance(db, project.id);

    expect(step).toMatchObject({ kind: "run", type: "voiceover" });
    expect(listJobs(db, { projectId: project.id }).some((j) => j.type === "voiceover")).toBe(true);
    const after = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(after.awaitingReview).toBe(false);
    expect(after.failureReason).toBeNull();
  });

  it("queues nothing for a finished project", () => {
    const project = newProject();
    buildUpTo(project.id, "done");
    const before = listJobs(db, { projectId: project.id }).length;

    expect(advance(db, project.id).kind).toBe("complete");
    expect(listJobs(db, { projectId: project.id })).toHaveLength(before);
  });
});

// M7 PR1 acceptance criterion 1: a fresh dev-format project's Development
// chain is empty, so its first stage — "concept" — is what's next.
describe("nextStep — Development chain", () => {
  function newDevProject() {
    const project = createProject(db, {
      idea: "a plumber became mayor by wits",
      format: "short_movie",
    });
    // A dev-format project queues nothing on creation (no generation logic
    // exists yet); confirm the queue really is empty before asserting on it.
    expect(listJobs(db, { projectId: project.id })).toHaveLength(0);
    return project;
  }

  it("reports 'concept' for a freshly created project with no dev_artifacts rows", () => {
    const project = newDevProject();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "concept" });
  });

  it("walks past approved stages to the first one without an approved row", () => {
    const project = newDevProject();
    db.insert(devArtifacts)
      .values({ projectId: project.id, stage: "concept", content: "c", approvedAt: new Date() })
      .run();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "logline" });
  });

  it("does not treat an unapproved row as done", () => {
    const project = newDevProject();
    db.insert(devArtifacts).values({ projectId: project.id, stage: "concept", content: "c" }).run();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "dev", stage: "concept" });
  });

  // M7 PR2: "characters" and "world_building" now sit between "logline" and
  // "story_structure" in the chain (see `DEV_CHAIN_STAGES`) but aren't
  // `dev_artifacts` rows — they're approved via `charactersApprovedAt` and
  // `world_building.approvedAt` respectively, so this test approves those two
  // stages by their own mechanism rather than inserting a `dev_artifacts` row
  // for them.
  /**
   * Every stage of the chain approved except the last one, "timeline" — the
   * point the two tests below vary from. Each stage is approved by its own
   * mechanism, which is the thing worth spelling out: `dev_artifacts` rows
   * for the eight artifact stages, a `projects` timestamp for the table
   * stages that have one, and the artifact's own existence for "previs" and
   * "casting" (see `devStageStatus`).
   */
  function approveEverythingBeforeTheTimeline() {
    const project = newDevProject();
    const artifactStages = [
      "concept",
      "logline",
      "story_structure",
      "beat_sheet",
      "treatment",
      "screenplay",
      "screenplay_revision",
      "story_bible",
      // Preproduction (M7 PR6/PR8/PR9) — the stages `DEV_CHAIN_STAGES`
      // currently ends on ("continuity"/"concept_art" are their own tables,
      // approved below like "characters"/"world_building").
      "script_breakdown",
      "scene_breakdown",
      "visual_bible",
      "production_design",
      // Preproduction (M7 PR13) — approved the ordinary `dev_artifacts` way,
      // like the other capstone ("story_bible") above.
      "production_plan",
    ] as const;
    for (const stage of artifactStages) {
      db.insert(devArtifacts)
        .values({ projectId: project.id, stage, content: "c", approvedAt: new Date() })
        .run();
    }
    db.insert(characters).values({ projectId: project.id, name: "Hal", description: "d" }).run();
    db.update(projects).set({ charactersApprovedAt: new Date() }).where(eq(projects.id, project.id)).run();
    // Preproduction (M7 PR12) — "casting" has no separate approval column
    // either; locking every character IS the approval (see `devStageStatus`'s
    // own comment on "casting"), so this is set directly rather than via a
    // timestamp column on `projects`.
    db.update(characters)
      .set({ castingLockedAt: new Date() })
      .where(eq(characters.projectId, project.id))
      .run();
    db.insert(worldBuilding)
      .values({ projectId: project.id, content: "w", approvedAt: new Date() })
      .run();
    // Preproduction (M7 PR7) — same "own table, own approval mechanism"
    // story as "characters"/"world_building" above.
    db.insert(continuityFacts)
      .values({ projectId: project.id, subjectType: "character", subjectId: "x", subjectName: "Hal", fact: "f" })
      .run();
    db.update(projects).set({ continuityApprovedAt: new Date() }).where(eq(projects.id, project.id)).run();
    // Preproduction (M7 PR9) — same "own table, own approval mechanism"
    // story as above; this project has no locations/props rows, so this is
    // also exercising the "nothing to generate, still needs an explicit
    // approval click" path rather than the "every row has an image" one.
    db.update(projects).set({ conceptArtApprovedAt: new Date() }).where(eq(projects.id, project.id)).run();
    // Preproduction (M7 PR10) — same "own table, own approval mechanism"
    // story as "continuity"/"concept_art" above.
    db.insert(storyboardPanels).values({ projectId: project.id, sceneId: "1", index: 0 }).run();
    db.update(projects).set({ storyboardsApprovedAt: new Date() }).where(eq(projects.id, project.id)).run();
    // Preproduction (M7 PR11) — same "own table, own approval mechanism"
    // story as "storyboards" above.
    db.insert(shotListItems).values({ projectId: project.id, sceneId: "1", index: 0 }).run();
    db.update(projects).set({ shotListApprovedAt: new Date() }).where(eq(projects.id, project.id)).run();
    // Preproduction (M7 PR11) — "previs" has no separate approval column;
    // setting `previsAssetId` IS the approval (see that column's own comment,
    // schema.ts), so this is the only stage here approved by inserting an
    // `assets` row rather than by setting a timestamp column.
    const [previsAsset] = db
      .insert(assets)
      .values({ kind: "video", path: "/tmp/previs.mp4", mimeType: "video/mp4", bytes: 1 })
      .returning()
      .all();
    db.update(projects).set({ previsAssetId: previsAsset!.id }).where(eq(projects.id, project.id)).run();

    return project;
  }

  it("reports complete once every stage has an approved row", () => {
    const project = approveEverythingBeforeTheTimeline();
    // Stage 22 (M7.2) — "timeline" owns its own tables, so it is approved by
    // a timestamp on its own settings row, alongside at least one segment.
    db.insert(timelines).values({ projectId: project.id, approvedAt: new Date() }).run();
    db.insert(timelineSegments)
      .values({ projectId: project.id, sceneId: "1", index: 0, durationMs: 4000 })
      .run();

    expect(nextStep(db, project.id)).toMatchObject({
      kind: "complete",
      reason: "Timeline approved, ready for Production",
    });
  });

  it("reports the timeline pending once it has segments awaiting a human", () => {
    const project = approveEverythingBeforeTheTimeline();
    db.insert(timelines).values({ projectId: project.id }).run();
    db.insert(timelineSegments)
      .values({ projectId: project.id, sceneId: "1", index: 0, durationMs: 4000 })
      .run();

    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "timeline",
      needsApproval: true,
    });
  });

  it("reports the timeline empty — not pending — when its settings row has no segments", () => {
    // The shape a stage that died mid-write leaves behind. Calling that
    // "pending" would put an approve button in front of nothing; calling it
    // "empty" re-runs the stage, which is what actually fixes it.
    const project = approveEverythingBeforeTheTimeline();
    db.insert(timelines).values({ projectId: project.id }).run();

    expect(nextStep(db, project.id)).toMatchObject({
      kind: "dev",
      stage: "timeline",
      needsApproval: false,
    });
  });

  // Acceptance criterion 2 — the single most important one: a project with no
  // `format` field (or an explicit `short_video_narrative`) is byte-for-byte
  // today's existing behaviour. `newProject()`/`buildUpTo` above already
  // cover this for every narrative stage; this just pins the format itself.
  it("runs the narrative chain unchanged for a project with no format specified", () => {
    const project = newProject();
    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "synopsis" });
  });
});
