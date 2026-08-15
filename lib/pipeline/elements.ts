import { asc, eq } from "drizzle-orm";
import { characters, scenes } from "../db/schema";
import { renderPrompt } from "../prompts";
import { enqueue } from "../queue";
import {
  awaitReview,
  checkAbort,
  groundingInstruction,
  loadProject,
  requireProjectId,
  resolveProvider,
  setStage,
  type StageContext,
} from "./context";
import { normaliseSpans, numberSentences, spanText, splitSentences } from "./segment";

type CharacterPayload = {
  characters?: { name?: unknown; description?: unknown; appearance?: unknown }[];
};

type ScenePayload = {
  storyboard?: unknown;
  imagePrompt?: unknown;
  characters?: unknown;
};

/**
 * Stage 4 — turn the approved story into scenes and a cast.
 *
 * Done in three passes rather than one call, because llama-server runs at a
 * fixed 4096-token context (finding F10) and one whole-story request asking
 * for eight fully-specified scenes silently truncates.
 *
 * The whole stage is resumable: rows are written as soon as they are known and
 * skipped on a retry, so a failure at scene six does not redo the first five —
 * which on this hardware is the difference between a retry and a restart.
 */
export async function runElements(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, narrativeStyle, imageStyle } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "llm");

  if (!project.story) throw new Error(`Project ${projectId} has no story to break down`);

  const sentences = splitSentences(project.story);
  if (sentences.length === 0) throw new Error(`Project ${projectId} has an empty story`);

  // Character/scene invention (names, appearances, causal details not in the
  // story) is exactly where fabrication tends to reappear even when the story
  // text itself stayed faithful, so Context mode's grounding reaches here too.
  const grounding = groundingInstruction(project);

  /* Pass 1 — the cast. */
  let cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
  if (cast.length === 0) {
    ctx.log("Extracting characters");
    const payload = await ctx.sdApi.llm.chatJson<CharacterPayload>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "elements.characters", {
            story: project.story,
            sceneGuidance: narrativeStyle.sceneGuidance,
            groundingInstruction: grounding,
          }),
        },
      ],
      temperature: 0.4,
    });

    // A character with no appearance is a failed extraction, not a character
    // to fill in from elsewhere: the appearance becomes the reference portrait
    // and is pasted into every scene prompt, so substituting `description`
    // (narrative prose, by the template's own definition) puts backstory into
    // a diffusion prompt — exactly what `elements.characters` forbids.
    const rows = (payload.characters ?? [])
      .filter((c) => typeof c?.name === "string" && (c.name as string).trim().length > 0)
      .filter((c) => typeof c?.appearance === "string" && (c.appearance as string).trim().length > 0)
      .slice(0, 4)
      .map((c) => ({
        projectId,
        name: (c.name as string).trim(),
        description: typeof c.description === "string" ? c.description.trim() : "",
        appearanceTag: (c.appearance as string).trim(),
      }));

    const dropped = (payload.characters ?? []).length - rows.length;
    if (dropped > 0) {
      ctx.log(`Dropped ${dropped} character(s) returned without an appearance description`, "warn");
    }

    if (rows.length > 0) {
      ctx.db.insert(characters).values(rows).run();
      cast = ctx.db.select().from(characters).where(eq(characters.projectId, projectId)).all();
    }
    ctx.log(`Found ${cast.length} character(s): ${cast.map((c) => c.name).join(", ") || "none"}`);
  }

  ctx.progress(0.15);
  checkAbort(ctx);

  /* Pass 2 — which sentences belong to which scene. */
  let sceneRows = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  if (sceneRows.length === 0) {
    ctx.log(`Grouping ${sentences.length} sentences into scenes`);
    const payload = await ctx.sdApi.llm.chatJson<{ scenes?: unknown }>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "elements.beats", {
            sentences: numberSentences(sentences),
            sentenceCount: String(sentences.length),
            targetSceneCount: String(narrativeStyle.targetSceneCount),
          }),
        },
      ],
      temperature: 0.3,
    });

    const spans = normaliseSpans(payload.scenes, sentences.length);
    ctx.db
      .insert(scenes)
      .values(
        spans.map((span, index) => ({
          projectId,
          index,
          description: span.description,
          // Verbatim narration, so the one-shot voiceover reproduces the
          // approved story exactly.
          voiceoverScript: spanText(sentences, span),
        })),
      )
      .run();

    sceneRows = ctx.db
      .select()
      .from(scenes)
      .where(eq(scenes.projectId, projectId))
      .orderBy(asc(scenes.index))
      .all();
    ctx.log(`Split into ${sceneRows.length} scene(s)`);
  }

  ctx.progress(0.25);

  /* Pass 3 — one storyboard and image prompt per scene. */
  // Appearance only — never `description`. See the extraction filter above.
  const castBlock =
    cast
      .filter((c) => c.appearanceTag)
      .map((c) => `- ${c.name}: ${c.appearanceTag}`)
      .join("\n") || "(nobody)";

  // A per-scene redo clears just that scene's prompt before enqueueing, but it
  // is not necessarily the only one pending: an earlier run that died partway
  // leaves other scenes without a prompt too, and they get picked up by the
  // same pass. So the direction is matched to its scene rather than assumed —
  // mirroring the guard `runSceneImages` already applies.
  const jobDirection = typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction : "";
  const jobSceneId = typeof ctx.job.payload.sceneId === "string" ? ctx.job.payload.sceneId : undefined;

  const pending = sceneRows.filter((scene) => !scene.imagePrompt);
  for (const [position, scene] of pending.entries()) {
    checkAbort(ctx);

    // The heading travels with the value: rendering "Additional direction…"
    // above an empty slot on every non-redo run leaves the model a labelled
    // blank to fill in.
    const steer = jobDirection && (!jobSceneId || jobSceneId === scene.id) ? jobDirection : "";
    const direction = steer ? `\nAdditional direction from the writer for this redo:\n${steer}` : "";

    const payload = await ctx.sdApi.llm.chatJson<ScenePayload>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "elements.scene", {
            sceneText: scene.voiceoverScript,
            sceneDescription: scene.description,
            characters: castBlock,
            sceneGuidance: narrativeStyle.sceneGuidance,
            // The model composing this prompt is shown the register its output
            // will be wrapped in, so it stops writing prompts that argue with
            // the wrapper — "richly saturated" into a ", desaturated colour"
            // suffix was the observed case (BUG-008).
            imageStyleGuidance: imageStyle.renderGuidance,
            direction,
            groundingInstruction: grounding,
          }),
        },
      ],
      temperature: 0.6,
    });

    const imagePrompt = typeof payload.imagePrompt === "string" ? payload.imagePrompt.trim() : "";
    if (!imagePrompt) {
      throw new Error(`Scene ${scene.index} came back without an image prompt`);
    }

    const named = Array.isArray(payload.characters)
      ? payload.characters.filter((n): n is string => typeof n === "string")
      : [];
    const characterIds = cast
      .filter((c) => named.some((n) => n.toLowerCase().includes(c.name.toLowerCase())))
      .map((c) => c.id);

    ctx.db
      .update(scenes)
      .set({
        storyboard: typeof payload.storyboard === "string" ? payload.storyboard.trim() : "",
        imagePrompt,
        characterIds,
      })
      .where(eq(scenes.id, scene.id))
      .run();

    ctx.progress(0.25 + (0.75 * (position + 1)) / pending.length);
    ctx.log(`Scene ${scene.index + 1}/${sceneRows.length} visualised`);
  }

  // `stage` records how far the project has got, so a one-scene redo on a
  // finished project must not report it back at `elements`.
  if (!jobSceneId) setStage(ctx.db, projectId, "elements");

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for review (manual mode)");
    return;
  }
  // A `sceneId`-scoped job is a user-requested redo of one scene's prompt,
  // not the stage completing its own pending list — advancing past it would
  // fire the whole downstream chain (portraits, images, voiceover...) for a
  // click that only asked for one prompt back (BUG-6).
  if (jobSceneId) return;
  // Portraits before scenes: scene images reference them, so this order is
  // load-bearing rather than incidental. See docs/adr/0001.
  enqueue(ctx.db, { type: "character_images", projectId });
}
