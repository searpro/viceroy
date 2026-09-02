import { asc, eq } from "drizzle-orm";
import { storeAsset } from "../assets";
import { characters, projects, sceneShots, scenes } from "../db/schema";
import { renderPrompt } from "../prompts";
import { projectAspect, sourceImageFor } from "../resolution";
import { enqueue } from "../queue";
import type { ImageBackend } from "../backends/types";
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
 * Drop any character reference the image host no longer holds.
 *
 * `refInputName` points at state in another service (the host's own inputs
 * directory), not at anything viceroy controls, so a name stored here can
 * dangle if that directory is ever cleared — regardless of whether the
 * reference came from a generated portrait or a user upload. ADR 0001 states
 * this must degrade to a text-only generation for the character rather than
 * fail the stage; this is that check, run once per scene-image stage rather
 * than once per scene, since the cast (and their references) don't change
 * mid-stage.
 *
 * Note this is about a reference that *went missing*, which is transient and
 * outside the user's control. A provider with no reference workflow at all is
 * a different situation — a configuration gap the user can fix — and that one
 * fails loudly rather than degrading.
 */
export async function filterLiveRefs(
  backend: Pick<ImageBackend, "hasReference" | "label">,
  cast: { id: string; name: string; refInputName: string | null }[],
  log: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<Map<string, string>> {
  const candidates = cast.filter((c): c is typeof c & { refInputName: string } => Boolean(c.refInputName));
  const checks = await Promise.all(candidates.map((c) => backend.hasReference(c.refInputName)));

  const live = new Map<string, string>();
  candidates.forEach((character, index) => {
    if (checks[index]) {
      live.set(character.id, character.refInputName);
    } else {
      log(
        `Reference image for ${character.name} is no longer available on ${backend.label}; ` +
          `generating their scenes as text-only`,
        "warn",
      );
    }
  });
  return live;
}

/**
 * The provider's avoid-list plus the style's, not one or the other.
 *
 * The two exclude different kinds of thing. A provider's list is a property of
 * the image *model* — malformed hands, extra fingers, text artifacts — and is
 * true of every generation it produces. A style's is aesthetic, and must not
 * leak between styles: noir's "flat lighting, low contrast" argues against the
 * available light documentary asks for, which is why BUG-014 moved these off
 * the provider in the first place.
 *
 * Letting the style *replace* the provider's fixed the leak and lost the
 * floor: every style then had to restate the model-level terms, and both
 * built-in styles omitted the anatomy ones, so nothing was guarding hands.
 * Concatenating keeps the floor under every generation and still lets each
 * style say what only applies to it.
 */
export function negativePromptFor(
  provider: { negativePrompt: string },
  style: { negativePrompt: string },
): string | undefined {
  const merged = [provider.negativePrompt, style.negativePrompt]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
  return merged || undefined;
}

/**
 * How many reference portraits one generation may carry, whatever the
 * workflow advertises.
 *
 * Measured, not chosen: reference conditioning costs about 130s each and
 * sd-api's default 600s `SD_JOB_TIMEOUT_MS` hard-fails at around five (finding
 * F30). M7.1 PR-A2 settled on the same three for storyboard panels.
 */
const REFERENCE_BUDGET = 3;

/**
 * Stage 6 — one image per shot.
 *
 * Until M9 this was one image per *scene*, held for the scene's whole
 * narration span — routinely fifteen to twenty-five seconds of a frame with
 * nothing moving but the Ken Burns drift, which is past the point a short-form
 * viewer stops watching. A scene is now covered by several shots and this
 * stage draws each of them.
 *
 * Each shot is generated with the reference portraits of the characters *in
 * that shot*, which is what holds a face steady between frames. See
 * docs/adr/0001. A shot with nobody in it — an insert of a hand on a handle, a
 * detail of a wall — carries no reference and costs about 51s instead of about
 * 142s (findings F12, F30). That is not an optimisation bolted on afterwards:
 * it is why `elements.shot` is told to put only the visible cast in its
 * `characters` array.
 *
 * Serial by necessity: image generation is the only CPU-bound stage on this
 * hardware (finding F9), and running two at once just splits the same cores.
 * With references on every shot a 180s narration is hours rather than minutes
 * of work here, which makes the resumability below the difference between a
 * retry and a restart — a failure at shot sixty costs one frame.
 *
 * A project that finished before M9 has no shots to draw and keeps its
 * scene-level stills; nothing here regenerates them.
 */
export async function runSceneImages(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, imageStyle } = loadProject(ctx.db, projectId);
  // The frame's shape is the project's, not the machine's (M7.1 PR-E) — the
  // pixel budget stays global, which is the part that genuinely is a property
  // of this hardware.
  const sourceSize = sourceImageFor(ctx.config, projectAspect(project));
  const imageProvider = resolveProvider(ctx.db, "image");

  const sceneRows = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  if (sceneRows.length === 0) throw new Error(`Project ${projectId} has no scenes to illustrate`);

  const cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  const backend = ctx.imageBackend();
  const refByCharacter = await filterLiveRefs(backend, cast, ctx.log);
  const refCapacity = backend.referenceCapacity();

  // A per-shot redo clears just that shot's image before enqueueing, so extra
  // direction is scoped to it rather than leaking into a bulk run. `sceneId`
  // scopes to every shot of one scene; both are also matched per row below,
  // because a run that died partway leaves other shots imageless too and they
  // get picked up by the same pass.
  const jobDirection = typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction.trim() : "";
  const jobSceneId = typeof ctx.job.payload.sceneId === "string" ? ctx.job.payload.sceneId : undefined;
  const jobShotId = typeof ctx.job.payload.shotId === "string" ? ctx.job.payload.shotId : undefined;

  const sceneById = new Map(sceneRows.map((scene) => [scene.id, scene]));
  const all = ctx.db
    .select()
    .from(sceneShots)
    .where(eq(sceneShots.projectId, projectId))
    .all()
    .sort((a, b) => {
      const byScene = sceneById.get(a.sceneId)!.index - sceneById.get(b.sceneId)!.index;
      return byScene !== 0 ? byScene : a.index - b.index;
    });

  if (all.length === 0) {
    throw new Error(
      `Project ${projectId} has scenes but no shots — element extraction has not covered them, ` +
        `so there is nothing to draw`,
    );
  }

  const pending = all.filter((shot) => !shot.imageAssetId);
  if (pending.length === 0) {
    ctx.log("Every shot already has an image");
  }

  for (const [position, shot] of pending.entries()) {
    checkAbort(ctx);
    const scene = sceneById.get(shot.sceneId)!;
    if (!shot.imagePrompt) {
      throw new Error(`Scene ${scene.index + 1} shot ${shot.index + 1} has no image prompt`);
    }

    const base = position / pending.length;
    const share = 1 / pending.length;

    const wanted = shot.characterIds
      .map((id) => refByCharacter.get(id))
      .filter((name): name is string => Boolean(name));

    // A workflow exposes a fixed number of reference slots, and a crowded
    // shot can want more faces than it has holes for. Dropping the extras is
    // a visible quality loss rather than a silent one, so it is logged as a
    // warning and left recoverable — failing the whole render would make any
    // provider with fewer slots than the busiest shot unusable.
    //
    // `REFERENCE_BUDGET` is the second ceiling and the one that usually bites:
    // references cost ~130s each and sd-api's own 600s SD_JOB_TIMEOUT_MS
    // hard-fails at about five of them (F30), so a shot is capped well under
    // that regardless of how many slots the workflow advertises. Same budget
    // M7.1 PR-A2 measured for storyboard panels.
    const refs = wanted.slice(0, Math.min(refCapacity, REFERENCE_BUDGET));
    if (wanted.length > refs.length) {
      ctx.log(
        `Scene ${scene.index + 1} shot ${shot.index + 1} has ${wanted.length} character reference(s) ` +
          `but only ${refs.length} can be used — generating with the first ${refs.length}`,
        "warn",
      );
    }

    const scoped = (!jobShotId || jobShotId === shot.id) && (!jobSceneId || jobSceneId === scene.id);
    const direction = jobDirection && scoped ? `, ${jobDirection}` : "";

    ctx.log(
      `Generating scene ${scene.index + 1} shot ${shot.index + 1} (${shot.shotType}), ` +
        `${position + 1}/${pending.length}` +
        (refs.length > 0 ? ` with ${refs.length} character reference(s)` : ""),
    );

    const bytes = await backend.generate(
      {
        prompt: `${imageStyle.promptPrefix}${shot.imagePrompt}${direction}${imageStyle.promptSuffix}`,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: sourceSize.width,
        height: sourceSize.height,
        references: refs,
      },
      {
        onProgress: (fraction) => ctx.progress(base + share * fraction),
        shouldAbort: ctx.shouldAbort,
        log: ctx.log,
      },
    );

    const asset = storeAsset(ctx.db, ctx.config, {
      kind: "image",
      bytes,
      mimeType: "image/png",
      projectId,
      label: `scene-${String(scene.index).padStart(2, "0")}-shot-${String(shot.index).padStart(2, "0")}`,
      meta: { sceneId: scene.id, shotId: shot.id, prompt: shot.imagePrompt },
    });

    ctx.db.update(sceneShots).set({ imageAssetId: asset.id }).where(eq(sceneShots.id, shot.id)).run();
    ctx.progress(base + share);
  }

  // See the note in `runElements`: a scoped redo is not the project reaching
  // this stage, so it must not move `stage` back to it.
  if (!jobSceneId && !jobShotId) setStage(ctx.db, projectId, "scene_images");
  ctx.log(`All ${all.length} shot image(s) ready`);

  const current = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()!;
  if (current.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for image review (manual mode)");
    return;
  }
  // A scoped job is a "redo image" click on one shot or one scene, not the
  // stage clearing its own pending list — advancing past it would fire
  // voiceover generation for a click that only asked for one frame (BUG-6).
  if (jobSceneId || jobShotId) return;
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
  // A narrative-pipeline portrait is both a reference and, effectively, a
  // frame of the same shape as the scenes it anchors, so it follows the
  // project's aspect. The Development chain's own portraits are pure
  // reference material and take `referenceImage` instead (M7.1 PR-A3).
  const sourceSize = sourceImageFor(ctx.config, projectAspect(project));
  const imageProvider = resolveProvider(ctx.db, "image");
  const backend = ctx.imageBackend();

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
    const bytes = await backend.generate(
      {
        prompt,
        negativePrompt: negativePromptFor(imageProvider, imageStyle) ?? "",
        width: sourceSize.width,
        height: sourceSize.height,
        // A portrait is the reference; it has none of its own.
        references: [],
      },
      {
        onProgress: (fraction) =>
          ctx.progress((position + fraction) / Math.max(pending.length, 1)),
        shouldAbort: ctx.shouldAbort,
        log: ctx.log,
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

    // Hand the portrait to the image host once. Scenes reference it by name,
    // so re-uploading per frame would copy the same bytes eight times.
    const refInputName = await backend.uploadReference(bytes, `${character.id}.png`);

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
