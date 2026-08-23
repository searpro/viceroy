import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, locations, shotListItems, timelines } from "../db/schema";
import { enqueue } from "../queue";
import { createProject, getProjectDetail } from "../projects";
import { stubContext } from "../pipeline/test-support";
import { runTimeline } from "../pipeline/timeline-stage";
import {
  loadTimeline,
  timelineSegmentPatchSchema,
  updateTimelineSegment,
  updateTimelineSettings,
} from "./store";

let db: Db;
let close: () => void;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
});
afterEach(() => close());

/**
 * An image asset, stored the way `storeAsset` actually stores one.
 *
 * Deliberately does NOT stamp `meta.projectId` — `storeAsset` uses the
 * project only to pick a directory and never records it on the row. An
 * earlier version of this helper invented that field, which made a broken
 * `projectImageAssets` look correct; the picker showed "none" for a segment
 * that plainly had a keyframe. A fixture that is kinder than production is
 * worse than no fixture.
 */
function imageAsset(label: string) {
  const [asset] = db
    .insert(assets)
    .values({ kind: "image", path: `/tmp/${label}.png`, mimeType: "image/png", bytes: 1, meta: { label } })
    .returning()
    .all();
  return asset!;
}

/** An asset this project owns — i.e. one a concept-art row points at. */
function projectAsset(projectId: string, name: string) {
  const asset = imageAsset(name);
  db.insert(locations)
    .values({ projectId, name, description: "d", imageAssetId: asset.id })
    .run();
  return asset;
}

async function projectWithTimeline() {
  const project = createProject(db, { idea: "a locksmith and her father's tools", format: "short_movie" });
  const keyframe = imageAsset("panel-1");
  db.insert(shotListItems)
    .values([
      { projectId: project.id, sceneId: "1", index: 0, motionPrompt: "m1", durationHintMs: 4000, keyframeAssetId: keyframe.id },
      { projectId: project.id, sceneId: "1", index: 1, motionPrompt: "m2", durationHintMs: 3000 },
      { projectId: project.id, sceneId: "2", index: 2, motionPrompt: "m3", durationHintMs: 5000 },
    ])
    .run();
  await runTimeline(stubContext(db, enqueue(db, { type: "timeline", projectId: project.id }), {}));
  return project;
}

describe("loadTimeline", () => {
  it("is undefined before the stage has run", () => {
    const project = createProject(db, { idea: "a lighthouse keeper who fears the dark", format: "short_movie" });
    expect(loadTimeline(db, project.id)).toBeUndefined();
  });

  it("derives timecodes rather than reading them back from a column", async () => {
    const project = await projectWithTimeline();
    const timeline = loadTimeline(db, project.id)!;

    expect(timeline.segments.map((s) => s.startMs)).toEqual([0, 4000, 7000]);
    expect(timeline.totalDurationMs).toBe(12000);
  });

  it("carries the project's own delivery dimensions and aspect", async () => {
    const project = await projectWithTimeline();
    const timeline = loadTimeline(db, project.id)!;
    expect(timeline.width).toBeGreaterThan(0);
    expect(timeline.height).toBeGreaterThan(0);
    // A short_movie defaults to landscape (M7.1 PR-E), which is what makes
    // the target's multiple-of-32 check meaningful here rather than academic.
    expect(timeline.aspectRatio).toBe("16:9");
  });
});

describe("updateTimelineSegment", () => {
  it("reflows every later segment when a duration changes", async () => {
    const project = await projectWithTimeline();
    const before = loadTimeline(db, project.id)!;

    const after = updateTimelineSegment(db, project.id, before.segments[0]!.id, { durationMs: 6000 });

    expect(after.segments.map((s) => s.startMs)).toEqual([0, 6000, 9000]);
    expect(after.totalDurationMs).toBe(14000);
  });

  it("accepts a keyframe from this project", async () => {
    const project = await projectWithTimeline();
    const timeline = loadTimeline(db, project.id)!;
    const asset = projectAsset(project.id, "Harbour workshop");

    const after = updateTimelineSegment(db, project.id, timeline.segments[1]!.id, {
      endKeyframeAssetId: asset.id,
    });
    expect(after.segments[1]!.endKeyframeAssetId).toBe(asset.id);
  });

  it("refuses a keyframe belonging to another project", async () => {
    const project = await projectWithTimeline();
    const other = createProject(db, { idea: "a different story", format: "short_movie" });
    const stranger = projectAsset(other.id, "Someone else's kitchen");
    const timeline = loadTimeline(db, project.id)!;

    expect(() =>
      updateTimelineSegment(db, project.id, timeline.segments[0]!.id, {
        startKeyframeAssetId: stranger.id,
      }),
    ).toThrow(/does not belong to project/);
  });

  it("refuses a segment belonging to another project", async () => {
    const project = await projectWithTimeline();
    const other = await projectWithTimeline();
    const strangerSegment = loadTimeline(db, other.id)!.segments[0]!;

    expect(() =>
      updateTimelineSegment(db, project.id, strangerSegment.id, { videoPrompt: "hijacked" }),
    ).toThrow(/No such timeline segment/);
  });

  it("clears a keyframe when passed null", async () => {
    const project = await projectWithTimeline();
    const timeline = loadTimeline(db, project.id)!;
    expect(timeline.segments[0]!.startKeyframeAssetId).not.toBeNull();

    const after = updateTimelineSegment(db, project.id, timeline.segments[0]!.id, {
      startKeyframeAssetId: null,
    });
    expect(after.segments[0]!.startKeyframeAssetId).toBeNull();
  });
});

describe("timelineSegmentPatchSchema", () => {
  it("rejects a duration typo without needing the target to weigh in", () => {
    // 120s is far past anything a segment could mean; the target's own
    // ~20s ceiling is reported as a validation issue, not a rejection, so a
    // user can see and fix it.
    expect(timelineSegmentPatchSchema.safeParse({ durationMs: 500_000 }).success).toBe(false);
    expect(timelineSegmentPatchSchema.safeParse({ durationMs: 25_000 }).success).toBe(true);
  });

  it("bounds guide strength to 0–1", () => {
    expect(timelineSegmentPatchSchema.safeParse({ guideStrength: 1.5 }).success).toBe(false);
    expect(timelineSegmentPatchSchema.safeParse({ guideStrength: 0.6 }).success).toBe(true);
  });

  it("ignores fields a segment does not own — the shot list owns those", () => {
    const parsed = timelineSegmentPatchSchema.parse({ index: 4, sceneId: "9", videoPrompt: "ok" });
    expect(parsed).toEqual({ videoPrompt: "ok" });
  });
});

describe("updateTimelineSettings", () => {
  it("changes the target, frame rate and global prompt", async () => {
    const project = await projectWithTimeline();
    const after = updateTimelineSettings(db, project.id, {
      fps: 25,
      globalPrompt: "grimy harbour town",
      targetId: "ltx-director",
    });
    expect(after).toMatchObject({ fps: 25, globalPrompt: "grimy harbour town", targetId: "ltx-director" });
  });

  it("refuses a target the registry does not carry", async () => {
    const project = await projectWithTimeline();
    // Caught at the schema boundary in the route; this is the second guard,
    // for a stored id whose target has since been removed.
    expect(() =>
      updateTimelineSettings(db, project.id, { targetId: "wan-vace" as never }),
    ).toThrow(/No such timeline target/);
  });

  it("refuses to edit a timeline that does not exist yet", () => {
    const project = createProject(db, { idea: "a lighthouse keeper who fears the dark", format: "short_movie" });
    expect(() => updateTimelineSettings(db, project.id, { fps: 25 })).toThrow(/no timeline/);
  });
});

describe("getProjectDetail", () => {
  it("serves the derived timeline and its keyframe candidates", async () => {
    const project = await projectWithTimeline();
    const detail = getProjectDetail(db, project.id)!;

    expect(detail.timeline?.segments).toHaveLength(3);
    expect(detail.timeline?.totalDurationMs).toBe(12000);
    expect(detail.timelineApprovedAt).toBeNull();
    // Labelled from the rows that reference them, not from the asset itself.
    // The picker must not offer another project's assets, since the PATCH
    // route derives its own answer from exactly this set.
    // Only shot 1 has a keyframe in this fixture, so only it is a candidate —
    // labelled from the row that references it, not from the asset.
    expect(detail.timelineAssets?.map((a) => a.label)).toEqual(["Scene 1 · shot 1"]);
  });

  it("offers concept art alongside shot keyframes, each labelled by what it is", async () => {
    const project = await projectWithTimeline();
    projectAsset(project.id, "Harbour workshop");

    expect(getProjectDetail(db, project.id)!.timelineAssets?.map((a) => a.label)).toEqual([
      "Scene 1 · shot 1",
      "Location: Harbour workshop",
    ]);
  });

  it("omits the timeline for a project that has not reached the stage", () => {
    const project = createProject(db, { idea: "a lighthouse keeper who fears the dark", format: "short_movie" });
    expect(getProjectDetail(db, project.id)!.timeline).toBeUndefined();
  });

  it("reports approval once a human signs the timeline off", async () => {
    const project = await projectWithTimeline();
    db.update(timelines).set({ approvedAt: new Date() }).where(eq(timelines.projectId, project.id)).run();
    expect(getProjectDetail(db, project.id)!.timelineApprovedAt).not.toBeNull();
  });
});
