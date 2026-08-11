import { asc, eq } from "drizzle-orm";
import { storeAsset } from "../assets";
import { characters, scenes } from "../db/schema";
import { renderPrompt } from "../prompts";
import { enqueue } from "../queue";
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
 * Each scene is generated with the reference portraits of the characters who
 * appear in it, which is what holds a face steady between frames. See
 * docs/adr/0001; measured cost is about +11 s per frame.
 *
 * Serial by necessity: image generation is the only CPU-bound stage on this
 * hardware (finding F9), measured at ~65 s per 432x768 frame, and running two
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

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const refByCharacter = new Map(
    cast.filter((c) => c.refInputName).map((c) => [c.id, c.refInputName!]),
  );

  const pending = all.filter((scene) => !scene.imageAssetId);
  if (pending.length === 0) {
    ctx.log("Every scene already has an image");
  }

  for (const [position, scene] of pending.entries()) {
    checkAbort(ctx);
    if (!scene.imagePrompt) throw new Error(`Scene ${scene.index} has no image prompt`);

    const base = position / pending.length;
    const share = 1 / pending.length;

    const refs = scene.characterIds
      .map((id) => refByCharacter.get(id))
      .filter((name): name is string => Boolean(name));

    ctx.log(
      `Generating image for scene ${scene.index + 1}/${all.length}` +
        (refs.length > 0 ? ` with ${refs.length} character reference(s)` : ""),
    );

    const bytes = await ctx.sdApi.image.generate(
      {
        prompt: `${imageStyle.promptPrefix}${scene.imagePrompt}${imageStyle.promptSuffix}`,
        negative_prompt: imageStyle.negativePrompt || undefined,
        model: imageStyle.model,
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
        ...(imageStyle.defaultParams as Record<string, never>),
        ...(refs.length > 0
          ? {
              ref_images: refs,
              // Distinct reference slots, so two people in one frame stay two
              // people. Harmless with a single reference.
              ...(refs.length > 1 ? { increase_ref_index: true } : {}),
            }
          : {}),
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
 * Runs before scene images and feeds them: each portrait is uploaded to sd-api
 * once and its name stored, so every scene the character appears in can point
 * at it via `ref_images`. This is what makes the protagonist the same person
 * across frames rather than merely a similar-looking one. See docs/adr/0001.
 *
 * A cast with no characters is normal — some narration depicts nobody — and
 * the stage simply passes through to scene images.
 */
export async function runCharacterImages(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, narrativeStyle, imageStyle } = loadProject(ctx.db, projectId);

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

    // Hand the portrait to sd-api once. Scenes reference it by name, so
    // re-uploading per frame would copy the same bytes eight times.
    const refInputName = await ctx.sdApi.image.uploadInput(
      bytes,
      `${character.id}.png`,
    );

    ctx.db
      .update(characters)
      .set({ imagePrompt: prompt, imageAssetId: asset.id, refInputName })
      .where(eq(characters.id, character.id))
      .run();
  }

  ctx.log(
    pending.length === 0
      ? "No portraits needed"
      : `${pending.length} portrait(s) generated and uploaded as references`,
  );

  setStage(ctx.db, projectId, "character_images");

  if (project.mode === "manual") {
    // A malformed portrait now propagates into every frame it appears in, so
    // manual mode is the point at which that is cheap to catch.
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for portrait review (manual mode)");
    return;
  }
  enqueue(ctx.db, { type: "scene_images", projectId });
}
