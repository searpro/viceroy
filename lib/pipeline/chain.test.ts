import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import {
  assets,
  characters,
  devArtifacts,
  evaluations,
  projects,
  renders,
  scenes,
  subtitleCues,
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
    db.insert(scenes)
      .values({
        projectId,
        index: 0,
        description: "s",
        voiceoverScript: "One. Two.",
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
    db.update(scenes)
      .set({ imageAssetId: imageAsset().id })
      .where(eq(scenes.projectId, projectId))
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
    db.update(scenes).set({ imageAssetId: null }).where(eq(scenes.projectId, project.id)).run();
    db.update(projects).set({ stage: "complete" }).where(eq(projects.id, project.id)).run();

    expect(nextStep(db, project.id)).toMatchObject({ kind: "run", type: "scene_images" });
  });

  it("re-extracts when a scene lost its image prompt", () => {
    const project = newProject();
    buildUpTo(project.id, "character_images");
    db.update(scenes).set({ imagePrompt: null }).where(eq(scenes.projectId, project.id)).run();
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
  it("reports complete once every stage has an approved row", () => {
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
      // Preproduction (M7 PR6) — the two stages `DEV_CHAIN_STAGES` currently
      // ends on.
      "script_breakdown",
      "scene_breakdown",
    ] as const;
    for (const stage of artifactStages) {
      db.insert(devArtifacts)
        .values({ projectId: project.id, stage, content: "c", approvedAt: new Date() })
        .run();
    }
    db.insert(characters).values({ projectId: project.id, name: "Hal", description: "d" }).run();
    db.update(projects).set({ charactersApprovedAt: new Date() }).where(eq(projects.id, project.id)).run();
    db.insert(worldBuilding)
      .values({ projectId: project.id, content: "w", approvedAt: new Date() })
      .run();

    expect(nextStep(db, project.id)).toMatchObject({
      kind: "complete",
      reason: "every Development/Preproduction stage built so far is approved",
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
