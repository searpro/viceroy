import { asc, eq } from "drizzle-orm";
import { characters, sceneShots, scenes } from "../db/schema";
import { renderPrompt } from "../prompts";
import { splitWords } from "./align";
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
import { assignShotTypes, partitionWords, planShotCount } from "./shots";

type CharacterPayload = {
  characters?: { name?: unknown; description?: unknown; appearance?: unknown }[];
};

type ScenePayload = {
  storyboard?: unknown;
  visualBrief?: unknown;
  // The pre-M9 name for this field, still accepted. See `briefFrom` below.
  imagePrompt?: unknown;
  characters?: unknown;
};

type ShotPayload = {
  storyboard?: unknown;
  imagePrompt?: unknown;
  characters?: unknown;
};

// Matches a negation anywhere in a sentence of a prose image prompt.
//
// A diffusion prompt has no grammatical negation — "a room with no windows"
// reads as a request for windows (F15) — but the instruction sits below the
// narration it governs, and on a 12B model source-text mimicry beats an
// instruction stated once (BUG-023). The rule is restated next to the
// `imagePrompt` field in the template too, but that only improves compliance;
// this strip is the guarantee that does not depend on it.
//
// Wider than the M9-predecessor's `^(no|not|without)` because prose puts a
// negation mid-sentence where a tag list put it first: "the desk holds nothing
// but a lamp" inverts exactly the way "no papers" does.
const NEGATION = /\b(no|not|nor|none|never|nothing|neither|without|cannot|can't|isn't|aren't|doesn't|don't)\b/i;

// Matches the framing rule restated as if it were a description of the frame,
// rather than applied to it — "The composition is vertical 9:16, with the man
// placed centrally for a tall frame" (BUG-24). The instruction sits one short
// step from being copied as content, same as the negation rule. It is
// redundant even when copied correctly: the real 9:16 frame comes from the
// width/height the image stage passes to the provider, not from tokens in the
// prompt, so any phrase naming the aspect ratio or restating "tall frame" /
// "portrait orientation" is noise to strip rather than a legitimate
// compositional instruction like "wide shot" or "close-up".
const FRAMING_RESTATEMENT = /\d{1,2}\s*:\s*\d{1,2}|aspect ratio|tall frame|portrait orientation/i;

/**
 * Drop any sentence of a prose prompt matching `pattern`.
 *
 * Mirrors `styles.ts`'s `refuseNegations` guard on style prefix/suffix text —
 * same failure class, but this prompt is model-authored rather than
 * user-authored, so the pipeline strips and logs instead of rejecting
 * outright: failing the whole shot over one clause the model shouldn't have
 * written just forces an identical retry.
 *
 * A whole sentence goes, not a clause, and that is deliberate. M9 moved these
 * prompts from comma-separated tags to prose (FLUX-family models read prose
 * considerably better than tags), and a prose sentence has no reliable
 * sub-boundary: splitting "the room is bare, with no windows and a single
 * door" on its comma leaves "with" dangling, while splitting on the period —
 * which the tag-era guard did — shreds every prose prompt into fragments.
 * Losing a quarter of the prompt is the cheaper mistake, because the sentence
 * being dropped is one the generator would have rendered backwards.
 */
function stripSentencesMatching(prose: string, pattern: RegExp): { prompt: string; stripped: string[] } {
  const stripped: string[] = [];
  const kept = splitSentences(prose).filter((sentence) => {
    if (pattern.test(sentence)) {
      stripped.push(sentence);
      return false;
    }
    return true;
  });
  return { prompt: kept.join(" "), stripped };
}

export function stripNegatedSentences(prose: string): { prompt: string; stripped: string[] } {
  return stripSentencesMatching(prose, NEGATION);
}

/** See `FRAMING_RESTATEMENT` above. */
export function stripFramingSentences(prose: string): { prompt: string; stripped: string[] } {
  return stripSentencesMatching(prose, FRAMING_RESTATEMENT);
}

/**
 * Run both guards over one model-written prose prompt, logging what went.
 *
 * Everything being stripped is a hard failure rather than an empty prompt
 * reaching the image stage: an empty prompt generates a picture of nothing,
 * which looks like a working pipeline producing bad art rather than a
 * malformed request.
 */
function sanitiseProse(
  prose: string,
  label: string,
  log: StageContext["log"],
): string {
  const negation = stripNegatedSentences(prose);
  if (negation.stripped.length > 0) {
    log(`${label}: stripped negated sentence(s): ${negation.stripped.join(" ")}`, "warn");
  }

  const framing = stripFramingSentences(negation.prompt);
  if (framing.stripped.length > 0) {
    log(`${label}: stripped framing restatement(s): ${framing.stripped.join(" ")}`, "warn");
  }

  if (!framing.prompt.trim()) {
    throw new Error(`${label} was entirely negation or framing restatement after stripping`);
  }
  return framing.prompt;
}

/**
 * The scene's brief, whichever field name it came back under.
 *
 * M9 renamed this stage's output from `imagePrompt` to `visualBrief`, and a
 * model asked for the new name will sometimes hand back the old one anyway —
 * they are both plausible names for "describe this scene" and a 12B model
 * answers with the one its training saw most.
 *
 * More to the point, the *template* can still be asking for the old name. A
 * row a user has edited is deliberately never overwritten by seeding
 * (`builtinTemplate` is what tells an edit apart from a merely old row), so a
 * shipped template change does not reach it — which is precisely how this
 * showed up: an installed `elements.scene` edited before M9 kept asking for
 * `imagePrompt`, the model complied, and the stage died at scene 0.
 *
 * Failing there is the wrong response to a usable answer. Taking either name
 * and logging the fallback keeps the stage running and still says, in the job
 * log, that a template needs resetting.
 */
function briefFrom(payload: ScenePayload, log: StageContext["log"], label: string): string {
  const brief = typeof payload.visualBrief === "string" ? payload.visualBrief.trim() : "";
  if (brief) return brief;

  const legacy = typeof payload.imagePrompt === "string" ? payload.imagePrompt.trim() : "";
  if (legacy) {
    log(
      `${label}: the model returned "imagePrompt" rather than "visualBrief" — using it, but the ` +
        `elements.scene template is probably an edited pre-M9 copy and should be reset`,
      "warn",
    );
  }
  return legacy;
}

/**
 * Stage 4 — turn the approved story into scenes and a cast.
 *
 * Done in four passes rather than one call, because llama-server runs at a
 * fixed 4096-token context (finding F10) and one whole-story request asking
 * for eight fully-specified scenes silently truncates. M9's fourth pass —
 * covering each scene with several shots — makes that ceiling tighter still,
 * which is why a shot's prompt is its own small call rather than a scene's
 * worth of them asked for at once.
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
    const payload = await ctx.llmClient(provider).chatJson<CharacterPayload>({
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
    const payload = await ctx.llmClient(provider).chatJson<{ scenes?: unknown }>({
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

  /* Pass 3 — the scene's visual brief. */
  // Appearance only — never `description`. See the extraction filter above.
  const castBlock =
    cast
      .filter((c) => c.appearanceTag)
      .map((c) => `- ${c.name}: ${c.appearanceTag}`)
      .join("\n") || "(nobody)";

  const namedCharacterIds = (named: unknown): string[] => {
    const names = Array.isArray(named) ? named.filter((n): n is string => typeof n === "string") : [];
    return cast
      .filter((c) => names.some((n) => n.toLowerCase().includes(c.name.toLowerCase())))
      .map((c) => c.id);
  };

  // A per-scene redo clears just that scene's prompt before enqueueing, but it
  // is not necessarily the only one pending: an earlier run that died partway
  // leaves other scenes without a prompt too, and they get picked up by the
  // same pass. So the direction is matched to its scene rather than assumed —
  // mirroring the guard `runSceneImages` already applies.
  const jobDirection = typeof ctx.job.payload.direction === "string" ? ctx.job.payload.direction : "";
  const jobSceneId = typeof ctx.job.payload.sceneId === "string" ? ctx.job.payload.sceneId : undefined;

  // The heading travels with the value: rendering "Additional direction…"
  // above an empty slot on every non-redo run leaves the model a labelled
  // blank to fill in.
  const directionFor = (sceneId: string): string => {
    const steer = jobDirection && (!jobSceneId || jobSceneId === sceneId) ? jobDirection : "";
    return steer ? `\nAdditional direction from the writer for this redo:\n${steer}` : "";
  };

  const briefless = sceneRows.filter((scene) => !scene.visualBrief);
  for (const [position, scene] of briefless.entries()) {
    checkAbort(ctx);

    const payload = await ctx.llmClient(provider).chatJson<ScenePayload>({
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
            direction: directionFor(scene.id),
            groundingInstruction: grounding,
          }),
        },
      ],
      temperature: 0.6,
    });

    const rawBrief = briefFrom(payload, ctx.log, `Scene ${scene.index + 1}`);
    if (!rawBrief) throw new Error(`Scene ${scene.index} came back without a visual brief`);

    ctx.db
      .update(scenes)
      .set({
        storyboard: typeof payload.storyboard === "string" ? payload.storyboard.trim() : "",
        visualBrief: sanitiseProse(rawBrief, `Scene ${scene.index + 1}'s visual brief`, ctx.log),
        characterIds: namedCharacterIds(payload.characters),
      })
      .where(eq(scenes.id, scene.id))
      .run();

    ctx.progress(0.25 + (0.25 * (position + 1)) / briefless.length);
    ctx.log(`Scene ${scene.index + 1}/${sceneRows.length} briefed`);
  }

  /* Pass 4 — cover each scene with shots (M9). */
  //
  // A scene used to be one picture held for its whole narration span, which on
  // a real project is fifteen to twenty-five seconds of a frame with nothing
  // moving but the Ken Burns drift.
  //
  // The word ranges are computed here, not asked for: `partitionWords`
  // guarantees they tile the scene exactly, where a model asked for ranges
  // routinely returns gaps and overlaps — the same reason `normaliseSpans`
  // repairs the scene grouping rather than trusting it. A gap here would be a
  // stretch of narration with no picture behind it.
  const pacing = {
    targetMs: narrativeStyle.shotTargetMs,
    minMs: narrativeStyle.shotMinMs,
    maxMs: narrativeStyle.shotMaxMs,
  };

  const briefed = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  for (const scene of briefed) {
    const existing = ctx.db.select().from(sceneShots).where(eq(sceneShots.sceneId, scene.id)).all();
    if (existing.length > 0) continue;

    const words = splitWords(scene.voiceoverScript).length;
    const ranges = partitionWords(scene.voiceoverScript, planShotCount(words, pacing));
    if (ranges.length === 0) continue;

    const types = assignShotTypes(ranges.length);
    ctx.db
      .insert(sceneShots)
      .values(
        ranges.map((range, index) => ({
          projectId,
          sceneId: scene.id,
          index,
          startWord: range.startWord,
          endWord: range.endWord,
          shotType: types[index]!,
        })),
      )
      .run();
  }

  const plannedShots = ctx.db
    .select()
    .from(sceneShots)
    .where(eq(sceneShots.projectId, projectId))
    .orderBy(asc(sceneShots.index))
    .all();
  const sceneById = new Map(briefed.map((scene) => [scene.id, scene]));

  const pendingShots = plannedShots
    .filter((shot) => !shot.imagePrompt)
    .sort((a, b) => {
      const byScene = sceneById.get(a.sceneId)!.index - sceneById.get(b.sceneId)!.index;
      return byScene !== 0 ? byScene : a.index - b.index;
    });

  ctx.log(
    `Covering ${briefed.length} scene(s) with ${plannedShots.length} shot(s); ` +
      `${pendingShots.length} still to write`,
  );

  for (const [position, shot] of pendingShots.entries()) {
    checkAbort(ctx);
    const scene = sceneById.get(shot.sceneId)!;

    // Each shot is written knowing what the scene's earlier shots already
    // showed. Without it every call writes the same framing: a model cannot
    // vary coverage across calls it cannot see, which is the lesson M7.1 PR-A2
    // learned about references. `shotType` is assigned rather than chosen for
    // the same reason; this is the half of it the model can actually act on.
    const written = ctx.db
      .select()
      .from(sceneShots)
      .where(eq(sceneShots.sceneId, shot.sceneId))
      .all()
      .filter((other) => other.index < shot.index && other.storyboard)
      // The last few only: under a 4096-token ceiling (F10) a long scene's
      // history would crowd out the instructions it is meant to support.
      .slice(-3)
      .map((other) => `- [${other.shotType}] ${other.storyboard}`)
      .join("\n");

    const priorShots = written
      ? `\nShots already used in this scene — do not repeat these framings:\n${written}`
      : "";

    const payload = await ctx.llmClient(provider).chatJson<ShotPayload>({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: renderPrompt(ctx.db, "elements.shot", {
            visualBrief: scene.visualBrief ?? "",
            shotText: shotNarration(scene.voiceoverScript, shot),
            sceneText: scene.voiceoverScript,
            shotType: shot.shotType,
            characters: castBlock,
            sceneGuidance: narrativeStyle.sceneGuidance,
            imageStyleGuidance: imageStyle.renderGuidance,
            priorShots,
            direction: directionFor(scene.id),
            groundingInstruction: grounding,
          }),
        },
      ],
      temperature: 0.6,
    });

    const rawPrompt = typeof payload.imagePrompt === "string" ? payload.imagePrompt.trim() : "";
    if (!rawPrompt) {
      throw new Error(`Scene ${scene.index + 1} shot ${shot.index + 1} came back without an image prompt`);
    }

    ctx.db
      .update(sceneShots)
      .set({
        storyboard: typeof payload.storyboard === "string" ? payload.storyboard.trim() : "",
        imagePrompt: sanitiseProse(
          rawPrompt,
          `Scene ${scene.index + 1} shot ${shot.index + 1}`,
          ctx.log,
        ),
        // Who is visible in THIS frame, not everyone in the scene — an insert
        // of a hand on a doorknob returns nobody, and that is what spares it
        // the ~142s a reference-conditioned frame costs (F30).
        characterIds: namedCharacterIds(payload.characters),
      })
      .where(eq(sceneShots.id, shot.id))
      .run();

    ctx.progress(0.5 + (0.5 * (position + 1)) / pendingShots.length);
    ctx.log(`Scene ${scene.index + 1} shot ${shot.index + 1}/${plannedShots.length} written`);
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
  // Portraits before shots: shot images reference them, so this order is
  // load-bearing rather than incidental. See docs/adr/0001.
  enqueue(ctx.db, { type: "character_images", projectId });
}

/**
 * The slice of a scene's narration one shot covers.
 *
 * Exported because the image stage needs the same answer when it logs which
 * line a frame belongs to, and two implementations of "which words are these"
 * is exactly how a range drifts from what it names.
 */
export function shotNarration(
  script: string,
  shot: { startWord: number; endWord: number },
): string {
  return splitWords(script)
    .slice(shot.startWord, shot.endWord + 1)
    .map((word) => word.surface)
    .join(" ");
}
