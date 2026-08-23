import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { projects, shotListItems, timelineSegments, timelines } from "../db/schema";
import { enqueue } from "../queue";
import { createProject, INVALIDATION_CHAIN, regenerate } from "../projects";
import { stubContext } from "./test-support";
import { runTimeline } from "./timeline-stage";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

/** A short_movie project with a shot list, without walking all 21 stages to get one. */
function projectWithShotList(
  shots: Partial<typeof shotListItems.$inferInsert>[] = [
    { sceneId: "1", index: 0, keyframePrompt: "k1", motionPrompt: "m1", durationHintMs: 3000 },
    { sceneId: "1", index: 1, keyframePrompt: "k2", motionPrompt: "m2", durationHintMs: 5000 },
    { sceneId: "2", index: 2, keyframePrompt: "k3", motionPrompt: "m3", durationHintMs: null },
  ],
) {
  const project = createProject(db, { idea: "a locksmith inherits her father's pick set", format: "short_movie" });
  for (const shot of shots) {
    db.insert(shotListItems)
      .values({ projectId: project.id, sceneId: "1", index: 0, ...shot })
      .run();
  }
  return project;
}

const run = (projectId: string) =>
  runTimeline(stubContext(db, enqueue(db, { type: "timeline", projectId }), {}));

describe("runTimeline — stage 22 (M7.2)", () => {
  it("seeds one segment per shot list item, in order", async () => {
    const project = projectWithShotList();
    await run(project.id);

    const segments = db
      .select()
      .from(timelineSegments)
      .where(eq(timelineSegments.projectId, project.id))
      .orderBy(asc(timelineSegments.index))
      .all();

    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(segments.map((s) => s.videoPrompt)).toEqual(["m1", "m2", "m3"]);
    expect(segments.map((s) => s.keyframePrompt)).toEqual(["k1", "k2", "k3"]);
    // The missing hint falls back to the shared default, the same number
    // `runPrevis` lays that shot out at.
    expect(segments.map((s) => s.durationMs)).toEqual([3000, 5000, 4000]);
    expect(segments.map((s) => s.shotListItemId).every(Boolean)).toBe(true);
  });

  /**
   * The one property that makes this stage worth having: it resolves no
   * provider and calls no model. `stubContext` throws if a stage reaches for
   * one it was not given, so asking for none is the assertion.
   */
  it("never calls a model — no LLM, no image backend, no video backend", async () => {
    const project = projectWithShotList();
    const job = enqueue(db, { type: "timeline", projectId: project.id });

    await expect(
      runTimeline(
        stubContext(db, job, {
          onImageRequest: () => {
            throw new Error("timeline must never call the image provider");
          },
          onVideoRequest: () => {
            throw new Error("timeline must never call the video provider");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("seeds the global prompt from the styles that already own that register", async () => {
    const project = projectWithShotList();
    await run(project.id);

    const row = db.select().from(timelines).where(eq(timelines.projectId, project.id)).get()!;
    // Image Style's `renderGuidance` is the rendering register; whatever the
    // seeded style says, the global prompt has to start as something rather
    // than an empty box for a human to face.
    expect(row.globalPrompt.length).toBeGreaterThan(0);
    expect(row.targetId).toBe("ltx-director");
    expect(row.fps).toBe(24);
    expect(row.approvedAt).toBeNull();
  });

  it("refuses to build a timeline from a project with no shot list", async () => {
    const project = projectWithShotList([]);
    await expect(run(project.id)).rejects.toThrow(/no shot list/);
  });

  it("rebuilds wholesale, replacing segments and un-approving, rather than merging", async () => {
    const project = projectWithShotList();
    await run(project.id);
    db.update(timelines)
      .set({ approvedAt: new Date(), globalPrompt: "hand-written by a person" })
      .where(eq(timelines.projectId, project.id))
      .run();

    // The shot list shrinks — the case a merge would get wrong by leaving a
    // segment behind for a shot that no longer exists.
    db.delete(shotListItems).where(eq(shotListItems.index, 2)).run();
    await run(project.id);

    const segments = db.select().from(timelineSegments).where(eq(timelineSegments.projectId, project.id)).all();
    expect(segments).toHaveLength(2);

    const row = db.select().from(timelines).where(eq(timelines.projectId, project.id)).get()!;
    expect(row.approvedAt).toBeNull();
    // Settings are the user's choices, not output, so a rebuild keeps them.
    expect(row.globalPrompt).toBe("hand-written by a person");
  });

  it("parks for review in manual mode, and does not in auto", async () => {
    const manual = projectWithShotList();
    db.update(projects).set({ mode: "manual" }).where(eq(projects.id, manual.id)).run();
    await run(manual.id);
    expect(db.select().from(projects).where(eq(projects.id, manual.id)).get()!.awaitingReview).toBe(true);

    const auto = projectWithShotList();
    db.update(projects).set({ mode: "auto" }).where(eq(projects.id, auto.id)).run();
    await run(auto.id);
    expect(db.select().from(projects).where(eq(projects.id, auto.id)).get()!.awaitingReview).toBe(false);
  });

  it("leaves the timeline unapproved, for a human to sign off", async () => {
    // What `devStageStatus` reads to report "pending". The `nextStep` view of
    // that lives in chain.test.ts, which has a project with every upstream
    // stage approved; this one deliberately does not, so `nextStep` here
    // would report stage 1.
    const project = projectWithShotList();
    await run(project.id);
    expect(db.select().from(timelines).where(eq(timelines.projectId, project.id)).get()!.approvedAt).toBeNull();
  });
});

describe("timeline invalidation (ADR 0003)", () => {
  it("sits last in INVALIDATION_CHAIN, so every upstream redo clears it", () => {
    expect(INVALIDATION_CHAIN[INVALIDATION_CHAIN.length - 1]).toBe("timeline");
  });

  it("is cleared by a shot_list redo — a timeline must not outlive its shots", async () => {
    const project = projectWithShotList();
    await run(project.id);
    db.update(timelines).set({ approvedAt: new Date() }).where(eq(timelines.projectId, project.id)).run();

    regenerate(db, project.id, { target: "shot_list" });

    expect(db.select().from(timelineSegments).where(eq(timelineSegments.projectId, project.id)).all()).toHaveLength(0);
    expect(db.select().from(timelines).where(eq(timelines.projectId, project.id)).get()!.approvedAt).toBeNull();
  });

  it("keeps the settings row's user-chosen fields through that cascade", async () => {
    const project = projectWithShotList();
    await run(project.id);
    db.update(timelines)
      .set({ approvedAt: new Date(), targetId: "ltx-director", fps: 25, globalPrompt: "mine" })
      .where(eq(timelines.projectId, project.id))
      .run();

    regenerate(db, project.id, { target: "storyboards" });

    const row = db.select().from(timelines).where(eq(timelines.projectId, project.id)).get()!;
    expect(row).toMatchObject({ fps: 25, globalPrompt: "mine", approvedAt: null });
  });
});
