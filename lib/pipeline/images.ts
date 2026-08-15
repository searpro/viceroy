import { asc, eq } from "drizzle-orm";
import { storeAsset } from "../assets";
import { characters, projects, scenes } from "../db/schema";
import { renderPrompt } from "../prompts";
import { enqueue } from "../queue";
import type { SdApi } from "../sdapi";
import {
  awaitReview,
  checkAbort,
  loadProject,
  requireProjectId,
  resolveProvider,
  setStage,
  type StageContext,
} from "./context";

/**
 * Drop any character reference sd-api no longer holds.
 *
 * `refInputName` points at state in another service (sd-api's own inputs
 * directory), not at anything viceroy controls, so a name stored here can
 * dangle if that directory is ever cleared — regardless of whether the
 * reference came from a generated portrait or a user upload. ADR 0001 states
 * this must degrade to a text-only generation for the character rather than
 * fail the stage; this is that check, run once per scene-image stage rather
 * than once per scene, since the cast (and their references) don't change
 * mid-stage.
 */
export async function filterLiveRefs(
  image: SdApi["image"],
  cast: { id: string; name: string; refInputName: string | null }[],
  log: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<Map<string, string>> {
  const candidates = cast.filter((c): c is typeof c & { refInputName: string } => Boolean(c.refInputName));
  const checks = await Promise.all(candidates.map((c) => image.hasInput(c.refInputName)));

  const live = new Map<string, string>();
  candidates.forEach((character, index) => {
    if (checks[index]) {
      live.set(character.id, character.refInputName);
    } else {
      log(
        `Reference image for ${character.name} is no longer available on sd-api; ` +
          `generating their scenes as text-only`,
        "warn",
      );
    }
  });
  return live;
}

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
  const imageProvider = resolveProvider(ctx.db, "image");

  const all = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  if (all.length === 0) throw new Error(`Project ${projectId} has no scenes to illustrate`);

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const refByCharacter = await filterLiveRefs(ctx.sdApi.image, cast, ctx.log);

  const pending = all.filter((scene) => !scene.imageAssetId);
  if (pending.length === 0) {
    ctx.log("Every scene already has an image");
  }

  // A per-scene redo clears just that scene's image before enqueueing, so
  // extra direction is scoped to it rather than leaking into a bulk run.
  const jobDirection = typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction.trim() : "";
  const jobSceneId = typeof ctx.job.payload.sceneId === "string" ? ctx.job.payload.sceneId : undefined;

  for (const [position, scene] of pending.entries()) {
    checkAbort(ctx);
    if (!scene.imagePrompt) throw new Error(`Scene ${scene.index} has no image prompt`);

    const base = position / pending.length;
    const share = 1 / pending.length;

    const refs = scene.characterIds
      .map((id) => refByCharacter.get(id))
      .filter((name): name is string => Boolean(name));

    const direction = jobDirection && (!jobSceneId || jobSceneId === scene.id) ? `, ${jobDirection}` : "";

    ctx.log(
      `Generating image for scene ${scene.index + 1}/${all.length}` +
        (refs.length > 0 ? ` with ${refs.length} character reference(s)` : ""),
    );

    const bytes = await ctx.sdApi.image.generate(
      {
        prompt: `${imageStyle.promptPrefix}${scene.imagePrompt}${direction}${imageStyle.promptSuffix}`,
        // The style's own avoid-list wins; the provider's is the fallback for
        // a style that carries none (BUG-014).
        negative_prompt: imageStyle.negativePrompt || imageProvider.negativePrompt || undefined,
        model: imageProvider.model,
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
        ...(imageProvider.defaultParams as Record<string, never>),
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

  // See the note in `runElements`: a scoped redo is not the project reaching
  // this stage, so it must not move `stage` back to it.
  if (!jobSceneId) setStage(ctx.db, projectId, "scene_images");
  ctx.log(`All ${all.length} scene image(s) ready`);

  const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for image review (manual mode)");
    return;
  }
  // A `sceneId`-scoped job is a "redo image" click on one scene, not the
  // stage clearing its own pending list — advancing past it would fire
  // voiceover generation for a click that only asked for one frame (BUG-6).
  if (jobSceneId) return;
  enqueue(ctx.db, { type: "voiceover", projectId });
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
  const { project, imageStyle } = loadProject(ctx.db, projectId);
  const imageProvider = resolveProvider(ctx.db, "image");

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();

  // A per-character redo clears just that character's portrait before
  // enqueueing, so extra direction is scoped to it rather than the whole cast.
  const jobDirection = typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction.trim() : "";
  const jobCharacterId =
    typeof ctx.job.payload.characterId === "string" ? ctx.job.payload.characterId : undefined;

  // In manual mode, a character with no portrait yet is not necessarily
  // "pending generation" — it may just be waiting on the user to pick Generate
  // vs. Use my photo for it (VIC-002/BUG-5). A `characterId`-scoped job (that
  // per-character "Generate" click) must therefore touch only that one
  // character, not every other cast member who also happens to be imageless.
  const pending = jobCharacterId
    ? cast.filter((character) => character.id === jobCharacterId && !character.imageAssetId)
    : cast.filter((character) => !character.imageAssetId);

  for (const [position, character] of pending.entries()) {
    checkAbort(ctx);

    const direction =
      jobDirection && (!jobCharacterId || jobCharacterId === character.id) ? `, ${jobDirection}` : "";

    // `description` is narrative prose ("an unassuming tradesman who never
    // wanted the job") and must never stand in for a missing appearance: it
    // would become this portrait, and the portrait is the reference every
    // scene the character appears in is generated against.
    if (!character.appearanceTag) {
      throw new Error(
        `Character "${character.name}" has no appearance description — ` +
          `re-run element extraction rather than drawing them from their backstory`,
      );
    }

    const prompt =
      `${imageStyle.promptPrefix}` +
      renderPrompt(ctx.db, "character.portrait", {
        characterDescription: character.appearanceTag,
      }) +
      direction +
      `${imageStyle.promptSuffix}`;

    ctx.log(`Generating portrait for ${character.name}`);
    const bytes = await ctx.sdApi.image.generate(
      {
        prompt,
        // The style's own avoid-list wins; the provider's is the fallback for
        // a style that carries none (BUG-014).
        negative_prompt: imageStyle.negativePrompt || imageProvider.negativePrompt || undefined,
        model: imageProvider.model,
        width: ctx.config.sourceImage.width,
        height: ctx.config.sourceImage.height,
        ...(imageProvider.defaultParams as Record<string, never>),
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

  if (!jobCharacterId) setStage(ctx.db, projectId, "character_images");

  if (project.mode === "manual") {
    // A malformed portrait now propagates into every frame it appears in, so
    // manual mode is the point at which that is cheap to catch.
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for portrait review (manual mode)");
    return;
  }
  // A `characterId`-scoped job is a "redo portrait" click on one character,
  // not the stage clearing its own pending list — advancing past it would
  // fire scene images (and from there, voiceover) for a click that only
  // asked for one portrait back (BUG-6).
  if (jobCharacterId) return;
  enqueue(ctx.db, { type: "scene_images", projectId });
}
