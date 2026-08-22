import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, projects, shotListItems } from "../db/schema";
import { claim, enqueue } from "../queue";
import { createProject } from "../projects";
import { stubContext } from "./test-support";

// `runPrevis` bundles and renders a real Remotion composition through
// `@remotion/bundler`/`@remotion/renderer`, exactly like the narrative
// pipeline's own `runRender` (render.ts) does — no test in this codebase
// invokes that for real (render.test.ts only exercises refusals, and
// verifies a real render live instead, per finding F7). Stubbed here the
// same way, so this test asserts the render pipeline is invoked correctly —
// composition id, staged shot count/order, output written where expected —
// without spending minutes running headless Chrome in CI.
const selectCompositionMock = vi.fn();
const renderMediaMock = vi.fn();

vi.mock("@remotion/bundler", () => ({
  bundle: vi.fn(async () => "http://stub-serve-url"),
}));
vi.mock("@remotion/renderer", () => ({
  ensureBrowser: vi.fn(async () => {}),
  selectComposition: (...args: unknown[]) => selectCompositionMock(...args),
  renderMedia: (...args: unknown[]) => renderMediaMock(...args),
}));

import { runPrevis } from "./previs";

let db: Db;
let close: () => void;
let dataDir: string;

beforeEach(() => {
  ({ db, close } = createTestDb());
  seed(db);
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "viceroy-previs-test-"));

  selectCompositionMock.mockReset();
  renderMediaMock.mockReset();
  selectCompositionMock.mockImplementation(
    async ({ id, inputProps }: { id: string; inputProps: { width: number; height: number } }) => ({
      id,
      width: inputProps.width,
      height: inputProps.height,
      fps: 30,
      durationInFrames: 90,
    }),
  );
  renderMediaMock.mockImplementation(async ({ outputLocation }: { outputLocation: string }) => {
    fs.writeFileSync(outputLocation, Buffer.from("fake-mp4-bytes"));
  });
});
afterEach(() => {
  close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let keyframeCounter = 0;

/** A real, on-disk keyframe file — `runPrevis` copies it byte-for-byte into its staging directory. */
function keyframeAsset() {
  const path = `${dataDir}/keyframe-${keyframeCounter++}.png`;
  fs.writeFileSync(path, Buffer.from("fake-png-bytes"));
  const [asset] = db
    .insert(assets)
    .values({ kind: "image", path, mimeType: "image/png", bytes: 4 })
    .returning()
    .all();
  return asset!;
}

describe("runPrevis refusals", () => {
  it("refuses a project with no shot list", async () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    claim(db);
    const job = enqueue(db, { type: "previs", projectId: project.id });
    await expect(runPrevis(stubContext(db, job))).rejects.toThrow(/no shot list/);
  });

  it("refuses when a shot list item has no keyframe image", async () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    claim(db);
    db.insert(shotListItems).values({ projectId: project.id, sceneId: "1", index: 0 }).run();
    const job = enqueue(db, { type: "previs", projectId: project.id });
    await expect(runPrevis(stubContext(db, job))).rejects.toThrow(/no keyframe image/);
  });
});

describe("runPrevis", () => {
  function projectWithShots(count = 2) {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    claim(db);
    for (let i = 0; i < count; i++) {
      const asset = keyframeAsset();
      db.insert(shotListItems)
        .values({
          projectId: project.id,
          sceneId: "1",
          index: i,
          keyframePrompt: `k${i}`,
          motionPrompt: `m${i}`,
          keyframeAssetId: asset.id,
          durationHintMs: 2000 + i * 1000,
        })
        .run();
    }
    return project;
  }

  it("stages every shot's keyframe, renders the Previs composition, and stores the result as a video asset", async () => {
    const project = projectWithShots(2);
    const job = enqueue(db, { type: "previs", projectId: project.id });

    await runPrevis(stubContext(db, job));

    expect(selectCompositionMock).toHaveBeenCalledTimes(1);
    const selectArgs = selectCompositionMock.mock.calls[0]![0] as { id: string; inputProps: { shots: unknown[] } };
    expect(selectArgs.id).toBe("Previs");
    expect(selectArgs.inputProps.shots).toHaveLength(2);

    expect(renderMediaMock).toHaveBeenCalledTimes(1);
    const renderArgs = renderMediaMock.mock.calls[0]![0] as { codec: string };
    expect(renderArgs.codec).toBe("h264");

    const updated = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(updated.previsAssetId).not.toBeNull();

    const asset = db.select().from(assets).where(eq(assets.id, updated.previsAssetId!)).get()!;
    expect(asset.kind).toBe("video");
    expect(asset.mimeType).toBe("video/mp4");
    expect(fs.existsSync(asset.path)).toBe(true);
  });

  it("passes each shot's own durationHintMs through to the composition, in index order", async () => {
    const project = projectWithShots(2);
    const job = enqueue(db, { type: "previs", projectId: project.id });

    await runPrevis(stubContext(db, job));

    const selectArgs = selectCompositionMock.mock.calls[0]![0] as {
      inputProps: { shots: { durationMs: number }[] };
    };
    expect(selectArgs.inputProps.shots.map((s) => s.durationMs)).toEqual([2000, 3000]);
  });

  it("falls back to a default duration when a shot list item's durationHintMs is null", async () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits" });
    claim(db);
    const asset = keyframeAsset();
    db.insert(shotListItems)
      .values({ projectId: project.id, sceneId: "1", index: 0, keyframeAssetId: asset.id, durationHintMs: null })
      .run();

    const job = enqueue(db, { type: "previs", projectId: project.id });
    await runPrevis(stubContext(db, job));

    const selectArgs = selectCompositionMock.mock.calls[0]![0] as {
      inputProps: { shots: { durationMs: number }[] };
    };
    expect(selectArgs.inputProps.shots[0]!.durationMs).toBeGreaterThan(0);
  });

  it("parks a manual-mode project for review once the render is done", async () => {
    const project = createProject(db, { idea: "a plumber became mayor by wits", mode: "manual" });
    claim(db);
    const asset = keyframeAsset();
    db.insert(shotListItems)
      .values({ projectId: project.id, sceneId: "1", index: 0, keyframeAssetId: asset.id, durationHintMs: 3000 })
      .run();

    const job = enqueue(db, { type: "previs", projectId: project.id });
    await runPrevis(stubContext(db, job));

    const updated = db.select().from(projects).where(eq(projects.id, project.id)).get()!;
    expect(updated.awaitingReview).toBe(true);
    expect(updated.previsAssetId).not.toBeNull();
  });
});
