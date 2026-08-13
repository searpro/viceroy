import { sql } from "drizzle-orm";
import { createDb, createSqlite, type Db } from "./client";
import { runMigrations } from "./migrate";
import { resolveConfig } from "../config";
import {
  captionStyles,
  imageStyles,
  narrativeStyles,
  preferences,
  promptTemplates,
  providers,
  voiceStyles,
} from "./schema";
import { DEFAULT_PROMPT_TEMPLATES } from "../prompts/defaults";
import { DEFAULT_CAPTION_STYLE } from "../../remotion/schema";

/**
 * Built-in narrative styles.
 *
 * The evaluation checklist is deliberately per style rather than one global
 * list: a bleak ending is a flaw in an underdog story and the point of a
 * cautionary one, so a single vocabulary could not judge both. The evaluator
 * is held to its own style's keys.
 */
const NARRATIVE_STYLES = [
  {
    name: "Crime Documentary",
    description:
      "Cold, factual retelling of a real-feeling crime. Builds through mounting specifics rather than drama.",
    plannerGuidance:
      "Structure as investigation: the scheme working, the first crack, the unravelling, the reckoning. " +
      "Anchor every beat to a concrete detail — a sum, a date, a document, a name. Withhold the full " +
      "picture until the turn. The audience should feel they are being shown evidence, not told a story.",
    writingGuidance:
      "Flat, precise, unhurried. Short declarative sentences. Let the facts carry the weight and never " +
      "editorialise — no 'shockingly', no 'unbelievably'. Specifics over adjectives: not 'a huge sum' " +
      "but 'a hundred and four million dollars'. Present tense for immediacy in the central beats.",
    // Phrased entirely as what IS in frame. Negations belong in the image
    // style's negativePrompt: a diffusion prompt has no "not", so "no fantasy
    // elements" pasted into a positive prompt asks for fantasy elements.
    visualGuidance:
      "Desaturated, documentary realism. Available light, hard shadows, handheld framing. Institutional " +
      "interiors, paperwork, surveillance angles, plain functional surfaces.",
    evaluationChecklist: [
      { key: "specificity", description: "Every claim is anchored to a concrete detail, not a generality." },
      { key: "restraint", description: "The prose never editorialises or reaches for shock." },
      { key: "escalation", description: "Each beat raises the stakes on the one before it." },
      { key: "payoff", description: "The reckoning lands and answers the hook the opening set." },
      { key: "spoken_clarity", description: "Reads cleanly aloud; no constructions that trip a narrator." },
    ],
    targetSceneCount: 8,
    targetWordCount: 320,
  },
  {
    name: "Underdog Rise",
    description:
      "An ordinary person outmanoeuvres a system that dismissed them. Warm, propulsive, satisfying.",
    plannerGuidance:
      "Structure as ascent: the dismissal, the overlooked advantage, the gambit, the vindication. The " +
      "protagonist must win through wit and specific competence, never luck. The opposition should be " +
      "credible and not cartoonish — a system's indifference is a better antagonist than a villain.",
    writingGuidance:
      "Warm, forward-leaning, a little wry. Vary sentence length and let the short ones land the turns. " +
      "Show competence through specific action, not through being told the character is clever. Earn the " +
      "ending — no sudden reversals the story has not paid for.",
    visualGuidance:
      "Warm natural light, richly saturated colour. Working environments and civic spaces — workshops, " +
      "municipal halls, streets at golden hour. Faces and hands doing real work.",
    evaluationChecklist: [
      { key: "earned_win", description: "The victory follows from choices the story showed, not luck." },
      { key: "credible_opposition", description: "What stands in the way is real and not a caricature." },
      { key: "momentum", description: "Every beat pushes forward; nothing restates what came before." },
      { key: "warmth", description: "The tone invites the listener in rather than lecturing them." },
      { key: "spoken_clarity", description: "Reads cleanly aloud; no constructions that trip a narrator." },
    ],
    targetSceneCount: 8,
    targetWordCount: 320,
  },
  {
    name: "Cautionary Tale",
    description:
      "A slow slide into consequence. The listener sees the ending coming and cannot look away.",
    plannerGuidance:
      "Structure as descent: the small first compromise, the normalisation, the point of no return, the " +
      "cost. Plant the ending in the opening beat so the listener recognises it when it arrives. The " +
      "protagonist's logic must be understandable at every step — the horror is that it makes sense.",
    writingGuidance:
      "Measured and quiet, tightening as it goes. Resist the urge to moralise; the consequence is the " +
      "argument. Keep the protagonist sympathetic even at their worst. End on the cost, not on a lesson.",
    visualGuidance:
      "Cool palette drifting colder. Domestic and ordinary settings made uneasy by framing and empty " +
      "space. Late light, interiors after dark, reflections.",
    evaluationChecklist: [
      { key: "inevitability", description: "The ending feels foretold by the opening, not tacked on." },
      { key: "sympathy", description: "The protagonist's reasoning stays understandable throughout." },
      { key: "no_moralising", description: "The story never states its lesson outright." },
      { key: "tightening", description: "Tension compounds rather than resetting between beats." },
      { key: "spoken_clarity", description: "Reads cleanly aloud; no constructions that trip a narrator." },
    ],
    targetSceneCount: 8,
    targetWordCount: 320,
  },
];

// `ttsInstruct` reaches the voice-design model verbatim, and ONLY through the
// task runner — see docs/findings.md F2. Phrases describing pitch, age and
// pace measurably move the output; vaguer mood words do much less.
const VOICE_STYLES = [
  {
    name: "Gravelly Documentarian",
    description: "Low, weathered, unhurried. Suits crime and cautionary material.",
    ttsInstruct:
      "a deep, gravelly older man speaking slowly and deliberately, low pitch, calm and grave, " +
      "with long pauses between sentences",
    deliveryCues:
      "Long sentences are fine; this voice has patience. Give it hard consonants and full stops to " +
      "land on. Avoid exclamation and avoid questions.",
  },
  {
    name: "Warm Storyteller",
    description: "Mid-range, friendly, conversational. Suits underdog and human-interest material.",
    ttsInstruct:
      "a warm friendly adult voice at a natural conversational pace, medium pitch, light and engaged, " +
      "with gentle emphasis on key words",
    deliveryCues:
      "Vary sentence length and let short sentences carry the turns. Direct address works well. Keep " +
      "clauses short enough to say in one breath.",
  },
  {
    name: "Urgent Newsreader",
    description: "Clipped, brisk, high-attention. Suits fast-moving reveals.",
    ttsInstruct:
      "a crisp professional newsreader speaking quickly and clearly, slightly raised pitch, urgent and " +
      "precise, minimal pauses",
    deliveryCues:
      "Short declarative sentences only. Front-load the fact in every sentence. Avoid subordinate " +
      "clauses — this pace cannot carry them.",
  },
];

// flux2-klein-4b measured at 51s per 432x768 frame on CPU (M0 step 3), against
// 55s for ssd-1b — faster AND a generation ahead in quality, so it wins on
// both counts. Its params are the bundle manifest's own: FLUX.2 klein is
// distilled to 4 steps at cfg 1, and raising either costs time without
// improving the image.
const IMAGE_PARAMS = { steps: 4, cfg_scale: 1, sampler: "euler" };
const IMAGE_MODEL = "flux2-klein-4b";

const IMAGE_STYLES = [
  {
    name: "Documentary Realism",
    description: "Desaturated, available-light realism. Reads as footage rather than illustration.",
    promptPrefix: "documentary photograph, available light, ",
    promptSuffix: ", desaturated colour, 35mm, natural skin texture, shallow depth of field",
    negativePrompt: "illustration, cartoon, painting, cgi, oversaturated, glossy, text, watermark",
    model: IMAGE_MODEL,
    defaultParams: IMAGE_PARAMS,
  },
  {
    name: "Cinematic Noir",
    description: "High contrast, hard shadows, cool palette. Suits cautionary and crime material.",
    promptPrefix: "cinematic film still, high contrast lighting, ",
    promptSuffix: ", deep shadows, cool colour grade, anamorphic, film grain",
    negativePrompt: "flat lighting, cartoon, cgi, text, watermark, low contrast",
    model: IMAGE_MODEL,
    defaultParams: IMAGE_PARAMS,
  },
];

const CAPTION_STYLES = [
  {
    name: "Standard",
    description: "Large white caption with a heavy black outline. Legible over any frame.",
    ...DEFAULT_CAPTION_STYLE,
  },
  {
    name: "Bold Uppercase",
    description: "All-caps, tighter to the bottom edge. Suits fast-cut, high-urgency material.",
    ...DEFAULT_CAPTION_STYLE,
    fontSize: 64,
    bottomOffset: 0.1,
    uppercase: true,
  },
];

const PROVIDERS = [
  { kind: "llm" as const, name: "sd-api (local)", model: "mistral-nemo-12b" },
  { kind: "image" as const, name: "sd-api (local)", model: IMAGE_MODEL },
  { kind: "audio" as const, name: "sd-api (local)", model: "qwen3-tts-voicedesign" },
  { kind: "asr" as const, name: "sd-api (local)", model: "parakeet-tdt" },
];

/**
 * Seed built-in data.
 *
 * Idempotent, and deliberately non-destructive: existing rows are left exactly
 * as they are. Prompt templates and styles are meant to be edited, so a
 * re-seed must never quietly revert someone's tuning.
 */
export function seed(db: Db): { inserted: Record<string, number> } {
  const inserted: Record<string, number> = {};

  inserted.promptTemplates = db
    .insert(promptTemplates)
    .values(DEFAULT_PROMPT_TEMPLATES)
    .onConflictDoNothing()
    .returning({ key: promptTemplates.key })
    .all().length;

  inserted.narrativeStyles = db
    .insert(narrativeStyles)
    .values(NARRATIVE_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: narrativeStyles.id })
    .all().length;

  inserted.voiceStyles = db
    .insert(voiceStyles)
    .values(VOICE_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: voiceStyles.id })
    .all().length;

  inserted.imageStyles = db
    .insert(imageStyles)
    .values(IMAGE_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: imageStyles.id })
    .all().length;

  inserted.captionStyles = db
    .insert(captionStyles)
    .values(CAPTION_STYLES.map((s) => ({ ...s, isBuiltin: true })))
    .onConflictDoNothing()
    .returning({ id: captionStyles.id })
    .all().length;

  const config = resolveConfig();
  const existingProviders = db.select({ kind: providers.kind }).from(providers).all();
  const haveKinds = new Set(existingProviders.map((p) => p.kind));
  const newProviders = PROVIDERS.filter((p) => !haveKinds.has(p.kind)).map((p) => ({
    ...p,
    baseUrl: config.sdApiUrl,
    isDefault: true,
  }));
  if (newProviders.length > 0) {
    db.insert(providers).values(newProviders).run();
  }
  inserted.providers = newProviders.length;

  db.insert(preferences)
    .values([
      { key: "defaultNarrativeStyle", value: NARRATIVE_STYLES[0]!.name },
      { key: "defaultVoiceStyle", value: VOICE_STYLES[0]!.name },
      { key: "defaultImageStyle", value: IMAGE_STYLES[0]!.name },
      { key: "defaultCaptionStyle", value: CAPTION_STYLES[0]!.name },
      { key: "defaultMode", value: "auto" },
    ])
    .onConflictDoNothing()
    .run();

  return { inserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = resolveConfig();
  const sqlite = createSqlite(config.databasePath);
  const db = createDb(sqlite);
  runMigrations(db);
  const { inserted } = seed(db);
  sqlite.close();
  console.log(
    `seeded ${config.databasePath}: ` +
      Object.entries(inserted)
        .map(([k, v]) => `${v} ${k}`)
        .join(", "),
  );
}

export { sql };
