import { asc, eq } from "drizzle-orm";
import { readAsset, storeAsset } from "../assets";
import { assets, sceneShots, scenes, subtitleCues, voiceovers } from "../db/schema";
import { enqueue } from "../queue";
import {
  awaitReview,
  checkAbort,
  loadProject,
  requireProjectId,
  resolveProvider,
  setStage,
  type StageContext,
} from "./context";
import { alignWords, buildCues, splitWords, type AlignedWord } from "./align";

/**
 * Stage 7 — the whole narration, spoken once.
 *
 * One TTS call for the entire story, not one per scene. Per-scene synthesis
 * produces audible voice drift between clips — a different breath, a different
 * pitch centre — and stitching cannot repair it. This is why scenes carry
 * verbatim spans of the narration: concatenating them reproduces exactly the
 * text that was reviewed.
 *
 * Voice design goes through Pepper's audio job queue, which honours the
 * instruction and survives the ~6 minutes a full narration takes. See the note
 * on `AudioClient.speech`, which supersedes finding F2.
 */
export async function runVoiceover(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project, voiceStyle } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "audio");

  const sceneRows = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  if (sceneRows.length === 0) throw new Error(`Project ${projectId} has no scenes to narrate`);

  const script = sceneRows.map((scene) => scene.voiceoverScript).join(" ");
  if (!script.trim()) throw new Error(`Project ${projectId} has an empty narration`);

  // A user may have redirected the voice; their cues win over the style's.
  const existing = ctx.db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get();
  const payloadInstruct =
    typeof ctx.job.payload.ttsInstruct === "string" ? ctx.job.payload.ttsInstruct.trim() : "";
  const ttsInstruct = payloadInstruct || existing?.ttsInstruct || voiceStyle.ttsInstruct;

  ctx.log(
    `Speaking ${splitWords(script).length} words in one pass as "${voiceStyle.name}" ` +
      `(${provider.model})`,
  );
  ctx.progress(0.1);
  checkAbort(ctx);

  const { audio, durationMs } = await ctx.sdApi.audio.speech(
    {
      model: provider.model,
      text: script,
      instruct: ttsInstruct,
    },
    {
      onProgress: (fraction) => ctx.progress(0.1 + 0.8 * fraction),
      shouldAbort: ctx.shouldAbort,
    },
  );

  assertPlausibleDuration(script, durationMs);

  const asset = storeAsset(ctx.db, ctx.config, {
    kind: "audio",
    bytes: audio,
    mimeType: "audio/wav",
    projectId,
    label: "narration",
    meta: { durationMs, instruct: ttsInstruct, model: provider.model },
  });

  const sampleRate = readWavSampleRate(audio);
  const values = {
    projectId,
    script,
    ttsInstruct,
    audioAssetId: asset.id,
    durationMs,
    sampleRate,
  };

  if (existing) {
    ctx.db.update(voiceovers).set(values).where(eq(voiceovers.id, existing.id)).run();
  } else {
    ctx.db.insert(voiceovers).values(values).run();
  }

  // Re-narrating invalidates every cue: they are timings into an audio file
  // that no longer exists.
  ctx.db.delete(subtitleCues).where(eq(subtitleCues.projectId, projectId)).run();

  setStage(ctx.db, projectId, "voiceover");
  ctx.log(`Narration generated: ${(durationMs / 1000).toFixed(1)}s at ${sampleRate ?? "?"}Hz`);

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for narration review (manual mode)");
    return;
  }
  enqueue(ctx.db, { type: "subtitle_align", projectId });
}

/**
 * Stage 8 — word-timed captions, carrying the authored wording.
 *
 * The transcript supplies timing and nothing else. Its words are aligned
 * against the narration and discarded; each caption shows what the writer
 * wrote. See `align.ts` and findings F5.
 */
export async function runSubtitleAlign(ctx: StageContext): Promise<void> {
  const projectId = requireProjectId(ctx.job);
  const { project } = loadProject(ctx.db, projectId);
  const provider = resolveProvider(ctx.db, "asr");

  const voiceover = ctx.db.select().from(voiceovers).where(eq(voiceovers.projectId, projectId)).get();
  if (!voiceover?.audioAssetId || !voiceover.durationMs) {
    throw new Error(`Project ${projectId} has no generated narration to align against`);
  }

  const audioAsset = ctx.db.select().from(assets).where(eq(assets.id, voiceover.audioAssetId)).get();
  if (!audioAsset) throw new Error(`Narration asset ${voiceover.audioAssetId} is missing`);

  const sceneRows = ctx.db
    .select()
    .from(scenes)
    .where(eq(scenes.projectId, projectId))
    .orderBy(asc(scenes.index))
    .all();

  ctx.progress(0.1);
  checkAbort(ctx);

  ctx.log(`Transcribing with ${provider.model} for word timings`);
  const { words } = await ctx.sdApi.audio.transcribeWords({
    model: provider.model,
    audio: readAsset(audioAsset.path),
    // The drift guard: alignment fails loudly rather than shipping captions
    // that run ahead of the audio. See findings F1.
    expectedDurationMs: voiceover.durationMs,
  });

  ctx.progress(0.6);

  const aligned = alignWords(voiceover.script, words, voiceover.durationMs);
  const matched = aligned.filter((word) => word.heard !== null).length;
  ctx.log(
    `Aligned ${matched}/${aligned.length} words against ${words.length} transcribed ` +
      `(${Math.round((100 * matched) / aligned.length)}% anchored)`,
  );

  // Scene scripts were joined with a single space, so word counts partition the
  // narration in the same order.
  let cursor = 0;
  const ranges = sceneRows.map((scene) => {
    const count = splitWords(scene.voiceoverScript).length;
    const range = { from: cursor, to: cursor + count - 1 };
    cursor += count;
    return { scene, range };
  });

  if (cursor !== aligned.length) {
    throw new Error(
      `Scene scripts account for ${cursor} words but the narration has ${aligned.length} — ` +
        `the scenes no longer partition the story, so cues cannot be assigned to images`,
    );
  }

  ctx.db.delete(subtitleCues).where(eq(subtitleCues.projectId, projectId)).run();

  let cueIndex = 0;
  let timedShots = 0;
  for (const { scene, range } of ranges) {
    const cues = buildCues(aligned, range);
    if (cues.length === 0) continue;

    ctx.db
      .insert(subtitleCues)
      .values(
        cues.map((cue) => ({
          projectId,
          sceneId: scene.id,
          index: cueIndex++,
          text: cue.text,
          heardText: cue.heardText,
          startMs: cue.startMs,
          endMs: cue.endMs,
        })),
      )
      .run();

    // Where this scene's narration sits on the timeline.
    ctx.db
      .update(scenes)
      .set({ startMs: cues[0]!.startMs, endMs: cues[cues.length - 1]!.endMs })
      .where(eq(scenes.id, scene.id))
      .run();

    timedShots += timeShots(ctx.db, scene.id, range.from, aligned);
  }

  setStage(ctx.db, projectId, "subtitle_align");
  ctx.progress(1);
  ctx.log(
    `${cueIndex} caption cue(s) and ${timedShots} shot window(s) across ${sceneRows.length} scene(s)`,
  );

  if (project.mode === "manual") {
    awaitReview(ctx.db, projectId);
    ctx.log("Stopping for caption review (manual mode)");
    return;
  }
  enqueue(ctx.db, { type: "render", projectId });
}

/**
 * Place a scene's shots on the timeline, from the words each one covers.
 *
 * This is the whole point of `scene_shots` storing a word range rather than a
 * duration. The ~150 wpm estimate that decided how many shots a scene has is
 * an estimate and will be wrong; the words themselves have been timed against
 * the real audio by this point, so a shot's window is measured, not scaled.
 * A scene that speaks slower than predicted gets proportionally longer shots
 * rather than shots that have slid off the narration — which is the failure
 * mode findings F1 and F5 were both opened for.
 *
 * `sceneStart` is where this scene's words begin in the whole narration;
 * `startWord`/`endWord` are relative to the scene, so the two compose.
 *
 * Returns how many shots were placed. Deliberately tolerant of a shot whose
 * range falls outside the aligned words — a scene re-split after alignment
 * would leave one — because the alternative is failing the caption stage over
 * a picture, and captions are the thing that must not break.
 */
export function timeShots(
  db: StageContext["db"],
  sceneId: string,
  sceneStart: number,
  aligned: AlignedWord[],
): number {
  const shots = db.select().from(sceneShots).where(eq(sceneShots.sceneId, sceneId)).all();

  let placed = 0;
  for (const shot of shots) {
    const first = aligned[sceneStart + shot.startWord];
    const last = aligned[sceneStart + shot.endWord];
    if (!first || !last) continue;

    db.update(sceneShots)
      .set({ startMs: first.startMs, endMs: last.endMs })
      .where(eq(sceneShots.id, shot.id))
      .run();
    placed++;
  }
  return placed;
}

/** Slowest and fastest plausible narration, in words per minute. */
const SLOWEST_WPM = 60;
const FASTEST_WPM = 260;

/**
 * Refuse narration that is too short or too long for the script it came from.
 *
 * The whole story goes to TTS in one call, and a model that truncates a long
 * input returns a perfectly valid shorter clip with no error. Nothing
 * downstream would notice: the transcript would match the audio, alignment
 * would anchor the opening and interpolate the rest, and the video would
 * simply stop narrating halfway through with captions sliding on regardless.
 *
 * The bounds are deliberately wide. This catches truncation and runaway
 * repetition, not an unusual delivery.
 */
export function assertPlausibleDuration(script: string, durationMs: number): void {
  const words = splitWords(script).length;
  if (words === 0) return;

  const wpm = words / (durationMs / 60_000);
  if (wpm > FASTEST_WPM) {
    throw new Error(
      `Narration is ${(durationMs / 1000).toFixed(1)}s for ${words} words (${Math.round(wpm)} wpm) — ` +
        `too fast to be the whole script, so the model probably truncated it`,
    );
  }
  if (wpm < SLOWEST_WPM) {
    throw new Error(
      `Narration is ${(durationMs / 1000).toFixed(1)}s for ${words} words (${Math.round(wpm)} wpm) — ` +
        `too slow to be speech, so the model probably looped or stalled`,
    );
  }
}

/**
 * Read the sample rate out of a WAV header.
 *
 * Stored as metadata for the renderer. It is emphatically **not** used to
 * convert ASR offsets — those are in the model's rate, not the file's, and
 * confusing the two is finding F1.
 */
export function readWavSampleRate(buffer: Buffer): number | null {
  if (buffer.length < 28) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "fmt ") return buffer.readUInt32LE(offset + 12);
    offset += 8 + size + (size % 2);
  }
  return null;
}
