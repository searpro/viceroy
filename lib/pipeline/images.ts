import { asc, eq } from "drizzle-orm";
import { storeAsset } from "../assets";
import { characters, scenes } from "../db/schema";
import { renderPrompt } from "../prompts";
import {
  awaitReview,
  checkAbort,
  loadProject,
  requireProjectId,
  setStage,
  type StageContext,
} from "./context";

/**
 * Stage 6 — one image per scene.
 *
 * Serial by necessity: image generation is the only CPU-bound stage on this
 * hardware (finding F9), measured at ~55 s per 432x768 frame, and running two
 * at once just splits the same cores.
 *
 * Resumable — a scene that already has an image is skipped, so a failure eight
 * minutes in costs one frame rather than all of them.
 */
export async function runSceneImages(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { imageStyle } = loadProject(ctx.db, projectId);

  const all = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  if (all.length === 0) throw new Error(`Project ${projectId} has no scenes to illustrate`);

  const pending = all.filter((scene) => !scene.imageAssetId);
  if (pending.length === 0) {
    ctx.log("Every scene already has an image");
  }

  for (const [position, scene] of pending.entries()) {
    checkAbort(ctx);
    if (!scene.imagePrompt) throw new Error(`Scene ${scene.index} has no image prompt`);

    const base = position / pending.length;
    const share = 1 / pending.length;

    ctx.log(`Generating image for scene ${scene.index + 1}/${all.length}`);
    const bytes = await ctx.sdApi.image.generate(
      {
        prompt: `${imageStyle.promptPrefix}${scene.imagePrompt}${imageStyle.promptSuffix}`,
        negative_prompt: imageStyle.negativePrompt || undefined,
        model: imageStyle.model,
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
        ...(imageStyle.defaultParams as Record<string, never>),
      },
      {
        onProgress: (fraction) => ctx.progress(base + share * fraction),
        shouldAbort: ctx.shouldAbort,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `scene-${String(scene.index).padStart(2, "0")}`,
      meta: { sceneId: scene.id, prompt: scene.imagePrompt },
    });

    ctx.db.update(scenes).set({ imageAssetId: asset.id }).where(eq(scenes.id, scene.id)).run();
    ctx.progress(base + share);
  }

  setStage(ctx.db, projectId, "scene_images");

  // PR4 replaces this with the voiceover stage.
  awaitReview(ctx.db, projectId);
  ctx.log(`All ${all.length} scene image(s) ready`);
}

/**
 * Stage 5 — reference portraits for the cast.
 *
 * Deliberately NOT part of the automatic chain. The plan had these generated
 * first so scene images could pass them as `ref_images` and hold a face
 * steady between frames — but `ref_images` maps to sd-cli's `-r`, which only
 * works on edit models (FLUX.1-Kontext, Qwen-Image-Edit, …), and none of the
 * installed bundles is one. Generating portraits nothing consumes would spend
 * a CPU-bound minute each for a thumbnail.
 *
 * Consistency is instead carried textually, by pasting each character's
 * `appearanceTag` into every scene prompt they appear in.
 *
 * This stage stays available on request, because the portraits are useful to
 * review and become real reference inputs the moment an edit model is
 * installed.
 */
export async function runCharacterImages(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { narrativeStyle, imageStyle } = loadProject(ctx.db, projectId);

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const pending = cast.filter((character) => !character.imageAssetId);

  for (const [position, character] of pending.entries()) {
    checkAbort(ctx);

    const prompt = renderPrompt(ctx.db, "character.portrait", {
      characterName: character.name,
      characterDescription: character.appearanceTag ?? character.description,
      visualGuidance: narrativeStyle.visualGuidance,
    });

    ctx.log(`Generating portrait for ${character.name}`);
    const bytes = await ctx.sdApi.image.generate(
      {
        prompt,
        negative_prompt: imageStyle.negativePrompt || undefined,
        model: imageStyle.model,
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
        ...(imageStyle.defaultParams as Record<string, never>),
      },
      {
        onProgress: (fraction) =>
          ctx.progress((position + fraction) / Math.max(pending.length, 1)),
        shouldAbort: ctx.shouldAbort,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `character-${character.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      meta: { characterId: character.id, prompt },
    });

    ctx.db
      .update(characters)
      .set({ imagePrompt: prompt, imageAssetId: asset.id })
      .where(eq(characters.id, character.id))
      .run();
  }

  ctx.log(`${pending.length} portrait(s) generated`);
}
