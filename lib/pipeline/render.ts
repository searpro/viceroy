import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { storeAsset } from "../assets";
import { captionStyleSchema, DEFAULT_CAPTION_STYLE, type CaptionStyle } from "../../remotion/schema";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { assets, captionStyles, renders, sceneShots, scenes, subtitleCues, voiceovers } from "../db/schema";
import {
  awaitReview,
  checkAbort,
  loadProject,
  requireProjectId,
  setStage,
  type StageContext,
} from "./context";

const COMPOSITION_ID = "StoryVideo";
const FPS = 30;

/**
 * A project created before `captionStyleId` existed has no row to resolve —
 * falling back to `DEFAULT_CAPTION_STYLE` keeps an old project renderable
 * instead of failing a stage over a column that predates it.
 *
 * `captionStyleSchema.parse` both validates and strips the row down to just
 * the fields the composition's schema declares, discarding
 * `id`/`name`/`description`/`isBuiltin`/timestamps.
 */
export function resolveRenderCaptionStyle(
  captionStyle: typeof captionStyles.$inferSelect | undefined,
): CaptionStyle {
  return captionStyle ? captionStyleSchema.parse(captionStyle) : DEFAULT_CAPTION_STYLE;
}

/**
 * A project created before `width`/`height` existed has neither set —
 * falling back to `config.video` keeps it renderable at the machine's
 * configured default instead of failing a stage over columns that predate it.
 */
export function resolveRenderDimensions(
  project: { width: number | null; height: number | null },
  config: Config,
): { width: number; height: number } {
  return {
    width: project.width ?? config.video.width,
    height: project.height ?? config.video.height,
  };
}

export type RenderShot = {
  /** Staging-directory basename, without extension — also what an error names. */
  label: string;
  imageAssetId: string | null;
  startMs: number | null;
  endMs: number | null;
};

/**
 * What goes on screen, in order — shots, or a pre-M9 project's scene stills.
 *
 * M9 made a scene a span of narration covered by several pictures, but
 * migrations are append-only and a project finished before it has no shots to
 * derive: its scenes carry the image and the timing directly. Falling back
 * keeps that project openable and re-renderable rather than stranding it, and
 * costs one branch — the shapes are the same three fields either way.
 *
 * The fallback is per project, not per scene. A half-covered project would be
 * a bug in element extraction, and silently rendering it as a mixture would
 * hide that behind a video that merely looks wrong.
 */
export function renderShots(
  db: Db,
  projectId: string,
  sceneRows: (typeof scenes.$inferSelect)[],
): RenderShot[] {
  const rows = db.select().from(sceneShots).where(eq(sceneShots.projectId, projectId)).all();

  if (rows.length === 0) {
    return sceneRows.map((scene) => ({
      label: `scene-${String(scene.index).padStart(2, "0")}`,
      imageAssetId: scene.imageAssetId,
      startMs: scene.startMs,
      endMs: scene.endMs,
    }));
  }

  const sceneIndexById = new Map(sceneRows.map((scene) => [scene.id, scene.index]));
  return rows
    .sort((a, b) => {
      const byScene = (sceneIndexById.get(a.sceneId) ?? 0) - (sceneIndexById.get(b.sceneId) ?? 0);
      return byScene !== 0 ? byScene : a.index - b.index;
    })
    .map((shot) => ({
      label:
        `scene-${String(sceneIndexById.get(shot.sceneId) ?? 0).padStart(2, "0")}` +
        `-shot-${String(shot.index).padStart(2, "0")}`,
      imageAssetId: shot.imageAssetId,
      startMs: shot.startMs,
      endMs: shot.endMs,
    }));
}

const remotionEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../remotion/index.ts",
);

/**
 * Stage 9 — the video.
 *
 * Remotion loads media through a headless browser, which can only read files
 * it is served. Rather than teach it about viceroy's asset layout, every input
 * is copied into a per-render staging directory that becomes the bundle's
 * public directory, so the composition refers to plain names like
 * `scene-00.png`.
 *
 * Copying costs a few megabytes and a moment; it also means a render is a
 * self-contained snapshot, so regenerating one scene's image later cannot
 * silently change what a finished video contains.
 */
export async function runRender(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, captionStyle } = loadProject(ctx.db, projectId);

  const voiceover = ctx.db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get();
  if (!voiceover?.audioAssetId || !voiceover.durationMs) {
    throw new Error(`Project ${projectId} has no narration to render against`);
  }

  const sceneRows = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  if (sceneRows.length === 0) throw new Error(`Project ${projectId} has no scenes`);

  const shots = renderShots(ctx.db, projectId, sceneRows);

  const untimed = shots.filter((shot) => shot.startMs === null || shot.endMs === null);
  if (untimed.length > 0) {
    throw new Error(
      `${untimed.length} shot(s) have no timeline position — subtitle alignment has not run, ` +
        `so there is nothing to say when each image should appear`,
    );
  }
  const missingImages = shots.filter((shot) => !shot.imageAssetId);
  if (missingImages.length > 0) {
    throw new Error(`${missingImages.length} shot(s) have no image`);
  }

  const cues = ctx.db
    .select()
    .from(subtitleCues)
    .where(eq(subtitleCues.projectId, projectId))
    .orderBy(asc(subtitleCues.index))
    .all();

  /* Stage every input under one directory. */
  const staging = path.join(ctx.config.cacheDir, `render-${projectId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const audioAsset = ctx.db.select().from(assets).where(eq(assets.id, voiceover.audioAssetId)).get();
  if (!audioAsset) throw new Error(`Narration asset ${voiceover.audioAssetId} is missing`);
  fs.copyFileSync(audioAsset.path, path.join(staging, "narration.wav"));

  const stagedShots = shots.map((shot) => {
    const asset = ctx.db.select().from(assets).where(eq(assets.id, shot.imageAssetId!)).get();
    if (!asset) throw new Error(`${shot.label} references a missing image asset`);
    const name = `${shot.label}${path.extname(asset.path)}`;
    fs.copyFileSync(asset.path, path.join(staging, name));
    return { src: name, startMs: shot.startMs!, endMs: shot.endMs! };
  });

  const dimensions = resolveRenderDimensions(project, ctx.config);

  const render = ctx.db
    .insert(renders)
    .values({
      projectId,
      width: dimensions.width,
      height: dimensions.height,
      fps: FPS,
      captionStyle: resolveRenderCaptionStyle(captionStyle),
      status: "rendering",
    })
    .returning()
    .all()[0]!;

  try {
    checkAbort(ctx);

    // First render on a machine downloads a headless Chrome; say so, because
    // otherwise the stage simply appears to hang for a few minutes.
    ctx.log("Ensuring a headless browser is available (first run downloads one)");
    await ensureBrowser();

    ctx.log("Bundling the composition");
    ctx.progress(0.05);
    const serveUrl = await bundle({ entryPoint: remotionEntry, publicDir: staging });

    const inputProps = {
      audioSrc: "narration.wav",
      shots: stagedShots,
      cues: cues.map((cue) => ({ text: cue.text, startMs: cue.startMs, endMs: cue.endMs })),
      durationMs: voiceover.durationMs,
      // Parsed, not passed through: a composition's zod schema documents
      // its props but does NOT fill defaults into inputProps at render time.
      // An unparsed {} reaches the component as undefined everywhere, and the
      // result is a 16px serif caption welded to the bottom edge rather than
      // an error. See docs/findings.md F22.
      captionStyle: captionStyleSchema.parse(render.captionStyle ?? {}),
      width: render.width,
      height: render.height,
    };

    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });

    const outputPath = path.join(staging, "video.mp4");
    ctx.log(
      `Rendering ${composition.width}x${composition.height} @ ${composition.fps}fps, ` +
        `${composition.durationInFrames} frames across ${stagedShots.length} shot(s)`,
    );

    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => ctx.progress(0.1 + 0.85 * progress),
    });

    const bytes = fs.readFileSync(outputPath);
    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "video",
      bytes,
      mimeType: "video/mp4",
      projectId,
      label: "video",
      meta: {
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
      },
    });

    ctx.db
      .update(renders)
      .set({ assetId: asset.id, status: "ready", error: null })
      .where(eq(renders.id, render.id))
      .run();

    setStage(ctx.db, projectId, "complete");
    awaitReview(ctx.db, projectId);
    ctx.progress(1);
    ctx.log(`Rendered ${(bytes.byteLength / 1048576).toFixed(1)}MB to ${asset.path}`);
  } catch (error) {
    ctx.db
      .update(renders)
      .set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      .where(eq(renders.id, render.id))
      .run();
    throw error;
  } finally {
    // Keep the staged inputs only when something went wrong — they are the
    // fastest way to reproduce a bad render.
    const failed = ctx.db.select().from(renders).where(eq(renders.id, render.id)).get()?.status;
    if (failed === "ready") fs.rmSync(staging, { recursive: true, force: true });
  }
}
