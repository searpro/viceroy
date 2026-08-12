import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../db/testing";
import { seed } from "../db/seed";
import type { Db } from "../db/client";
import { assets, projects, scenes, voiceovers } from "../db/schema";
import { claim, enqueue } from "../queue";
import { createProject } from "../projects";
import { runRender } from "./render";
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
  it("refuses when scenes have no timeline position", async () => {
    const p = project({ images: true, narrated: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no timeline position/);
  });

  it("refuses when a scene has no image", async () => {
    const p = project({ timed: true, narrated: true });
    const job = enqueue(db, { type: "render", projectId: p.id });
    await expect(runRender(stubContext(db, job))).rejects.toThrow(/no image/);
  });
});
