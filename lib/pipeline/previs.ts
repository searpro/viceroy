import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { storeAsset } from "../assets";
import { DEFAULT_SEGMENT_DURATION_MS } from "../timeline/build";
import { previsSchema } from "../../remotion/schema";
import { assets, projects, shotListItems } from "../db/schema";
import {
  awaitReview,
  checkAbort,
  loadProject,
  requireProjectId,
  type StageContext,
} from "./context";

const COMPOSITION_ID = "Previs";
const FPS = 30;

// A shot list item's own `durationHintMs` is nullable (a row a stage failed
// to write cleanly, or one hand-edited to blank) — this is what a shot holds
// for when there's nothing better to go on, same mid-range choice
// `runShotList`'s own default makes (dev.ts) and the production timeline's
// own `seedSegments` makes (M7.2). One constant now, so the animatic and the
// timeline cannot describe different arrangements of the same shot list.
const DEFAULT_SHOT_DURATION_MS = DEFAULT_SEGMENT_DURATION_MS;

const remotionEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../remotion/index.ts",
);

/**
 * Stage 20 (M7 PR11) — the thin animatic.
 *
 * Mirrors `runRender`'s (render.ts) staging/bundle/render shape, deliberately
 * much simpler: no `renders` table row (that table's status/error/retry
 * lifecycle is narrative-pipeline-specific — tied to `scenes`, caption style
 * and a render that can be redone against unchanged inputs — none of which
 * previs has: it has exactly one input set, the approved shot list, and
 * exactly one output). The finished animatic is stored the same way any
 * other generated artifact in this codebase is — a plain `assets` row via
 * `storeAsset` — and its id is recorded directly on `projects.previsAssetId`
 * rather than through a second table's own status column.
 *
 * No sd-api call of any kind, LLM or image or video-provider — every pixel
 * this stage needs already exists as a `shot_list_items.keyframeAssetId`
 * (defaulted from the source storyboard panel's own image by `runShotList`).
 * This is what lets previs "render... without needing any LTX/video-provider
 * work" per this PR's own acceptance bar: it is a Remotion composition
 * sequencing still images, not a generation call of its own.
 */
export async function runPrevis(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project } = loadProject(ctx.db, projectId);

  const items = ctx.db
    .select()
    .from(shotListItems)
    .where(eq(shotListItems.projectId, projectId))
    .orderBy(asc(shotListItems.index))
    .all();
  if (items.length === 0) {
    throw new Error(`Project ${projectId} has no shot list to build a previs from`);
  }
  const missingKeyframes = items.filter((item) => !item.keyframeAssetId);
  if (missingKeyframes.length > 0) {
    throw new Error(`${missingKeyframes.length} shot list item(s) have no keyframe image`);
  }

  /* Stage every keyframe under one directory — same reasoning as `runRender`'s
   * own staging step: Remotion's headless browser can only read files it is
   * served, and a self-contained snapshot means a keyframe regenerated later
   * cannot silently change what an already-finished previs contains. */
  const staging = path.join(ctx.config.cacheDir, `previs-${projectId}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const stagedShots = items.map((item, i) => {
    const asset = ctx.db.select().from(assets).where(eq(assets.id, item.keyframeAssetId!)).get();
    if (!asset) throw new Error(`Shot list item ${item.id} references a missing keyframe asset`);
    const name = `shot-${String(i).padStart(2, "0")}${path.extname(asset.path)}`;
    fs.copyFileSync(asset.path, path.join(staging, name));
    return { src: name, durationMs: item.durationHintMs ?? DEFAULT_SHOT_DURATION_MS };
  });

  let succeeded = false;
  try {
    checkAbort(ctx);

    // First render on a machine downloads a headless Chrome; say so, same as
    // `runRender` does — otherwise the stage simply appears to hang.
    ctx.log("Ensuring a headless browser is available (first run downloads one)");
    await ensureBrowser();

    ctx.log("Bundling the previs composition");
    ctx.progress(0.05);
    const serveUrl = await bundle({ entryPoint: remotionEntry, publicDir: staging });

    const inputProps = previsSchema.parse({
      shots: stagedShots,
      width: project.width ?? ctx.config.video.width,
      height: project.height ?? ctx.config.video.height,
      fps: FPS,
    });

    const composition = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });

    const outputPath = path.join(staging, "previs.mp4");
    ctx.log(
      `Rendering ${composition.width}x${composition.height} @ ${composition.fps}fps, ` +
        `${composition.durationInFrames} frames, ${stagedShots.length} shot(s)`,
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
      label: "previs",
      meta: {
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        shots: stagedShots.length,
      },
    });

    // No separate approval column — setting this IS the approval, per
    // `projects.previsAssetId`'s own comment (schema.ts).
    ctx.db.update(projects).set({ previsAssetId: asset.id }).where(eq(projects.id, projectId)).run();

    succeeded = true;
    ctx.progress(1);
    ctx.log(`Previs rendered: ${(bytes.byteLength / 1048576).toFixed(1)}MB to ${asset.path}`);
  } finally {
    // Keep the staged inputs only when something went wrong — same
    // fastest-way-to-reproduce-a-bad-render reasoning as `runRender`.
    if (succeeded) fs.rmSync(staging, { recursive: true, force: true });
  }

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  ctx.log("Previs is the last Preproduction stage defined so far — nothing further to enqueue");
}
